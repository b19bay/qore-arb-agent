// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/AgentVault.sol";
import "../src/SimplePool.sol";
import "../src/TestToken.sol";

/// @notice Configurable stand-in for a pool/router target.
contract MockTarget {
    uint256 public returnAmount;
    bool public shouldRevert;
    AgentVault public vault;
    bool public reentered;

    function setVault(address v) external {
        vault = AgentVault(payable(v));
    }

    function setReturn(uint256 r) external {
        returnAmount = r;
    }

    function setRevert(bool b) external {
        shouldRevert = b;
    }

    function trade() external payable returns (uint256) {
        if (shouldRevert) revert("MockTarget: boom");
        return returnAmount;
    }

    /// @dev Returns empty returndata so the vault must reject it.
    function tradeEmpty() external payable {}

    /// @dev Attempts to re-enter the vault mid-trade. Only meaningful when
    ///      this contract IS the vault's agent (see testReentrancyBlocked).
    function tradeReenter() external payable returns (uint256) {
        try vault.executeTrade(address(this), abi.encodeWithSignature("trade()"), 0.1 ether, 0) {
            reentered = true;
        } catch {}
        return returnAmount;
    }

    receive() external payable {}
}

contract AgentVaultTest is Test {
    AgentVault public vault;
    MockTarget public target;
    TestToken public token;
    SimplePool public poolA;
    SimplePool public poolB;

    address public owner;
    address public agent = makeAddr("agent");
    address public stranger = makeAddr("stranger");

    uint256 public constant MAX_PER_TRADE = 0.5 ether;
    uint256 public constant DAILY_LIMIT = 2 ether;
    uint256 public constant MAX_LOSSES = 3;

    function setUp() public {
        owner = address(this);
        vault = new AgentVault(agent, MAX_PER_TRADE, DAILY_LIMIT, block.timestamp + 7 days, MAX_LOSSES);
        target = new MockTarget();
        target.setVault(address(vault));
        target.setReturn(0.6 ether);
        vault.addTarget(address(target));
        vault.deposit{value: 10 ether}();
    }

    // ---------- happy path ----------

    function testDeposit() public {
        uint256 before = address(vault).balance;
        vm.prank(stranger);
        vm.deal(stranger, 1 ether);
        vault.deposit{value: 1 ether}();
        assertEq(address(vault).balance, before + 1 ether);
    }

    function testPlainTransferEmitsNoDepositedEvent() public {
        // Revision 2: pool refunds/proceeds arrive as plain transfers and
        // must NOT appear as Deposited in the audit log.
        vm.recordLogs();
        (bool ok,) = payable(address(vault)).call{value: 0.5 ether}("");
        assertTrue(ok);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 depositedTopic = keccak256("Deposited(address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != depositedTopic, "plain transfer emitted Deposited");
        }
        assertEq(address(vault).balance, 10.5 ether);
    }

    function testExecuteTradeSuccess() public {
        vm.prank(agent);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0.5 ether);
        assertEq(vault.tradeCount(), 1);
        assertEq(vault.spentLast24h(), 0.5 ether);
        assertEq(vault.consecutiveLosses(), 0);
        assertEq(address(vault).balance, 9.5 ether);
    }

    // ---------- access control ----------

    function testExecuteTradeNonAgentReverts() public {
        vm.prank(stranger);
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
    }

    function testExecuteTradeOwnerReverts() public {
        // The owner cannot trade directly — only through the agent.
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
    }

    function testTargetNotAllowedReverts() public {
        MockTarget other = new MockTarget();
        vm.prank(agent);
        vm.expectRevert(AgentVault.TargetNotAllowed.selector);
        vault.executeTrade(address(other), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
    }

    function testExceedsPerTradeCapReverts() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.ExceedsPerTradeCap.selector);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether + 1, 0);
    }

    function testExceedsDailyLimitReverts() public {
        // Separate vault with a 1.2 QOR daily limit: 0.5 + 0.5 fits, the
        // third 0.5 would exceed it (1.5 > 1.2).
        AgentVault small =
            new AgentVault(agent, MAX_PER_TRADE, 1.2 ether, block.timestamp + 7 days, MAX_LOSSES);
        small.addTarget(address(target));
        small.deposit{value: 10 ether}();
        vm.startPrank(agent);
        small.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        small.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        vm.expectRevert(AgentVault.ExceedsDailyLimit.selector);
        small.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        vm.stopPrank();
    }

    function testAfterExpiryReverts() public {
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(agent);
        vm.expectRevert(AgentVault.AuthExpired.selector);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
    }

    function testHaltedReverts() public {
        vault.halt();
        assertTrue(vault.isHalted());
        vm.prank(agent);
        vm.expectRevert(AgentVault.IsHalted.selector);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
    }

    // ---------- output / target failures ----------

    function testOutputBelowMinOutReverts() public {
        target.setReturn(0.4 ether);
        vm.prank(agent);
        vm.expectRevert(AgentVault.OutputBelowMinOut.selector);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0.5 ether);
    }

    function testTargetCallFailsReverts() public {
        target.setRevert(true);
        vm.prank(agent);
        vm.expectRevert(AgentVault.TargetCallFailed.selector);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
    }

    function testBadReturnDataReverts() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.BadReturnData.selector);
        vault.executeTrade(address(target), abi.encodeWithSignature("tradeEmpty()"), 0.5 ether, 0);
    }

    // ---------- auto-halt ----------

    function testAutoHaltAfterConsecutiveLosses() public {
        target.setReturn(0.4 ether); // loss: 0.4 out < 0.5 in
        vm.startPrank(agent);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        assertFalse(vault.isHalted());
        assertEq(vault.consecutiveLosses(), 2);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        vm.stopPrank();
        assertTrue(vault.isHalted());
        assertEq(vault.consecutiveLosses(), 3);
        vm.prank(agent);
        vm.expectRevert(AgentVault.IsHalted.selector);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
    }

    function testDailyBudgetExhaustionAutoHalts() public {
        vm.startPrank(agent);
        for (uint256 i = 0; i < 4; i++) {
            vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        }
        vm.stopPrank();
        assertEq(vault.spentLast24h(), 2 ether);
        assertTrue(vault.isHalted());
    }

    function testProfitResetsLossStreak() public {
        target.setReturn(0.4 ether);
        vm.startPrank(agent);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        vm.stopPrank();
        assertEq(vault.consecutiveLosses(), 2);
        target.setReturn(0.6 ether);
        vm.prank(agent);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        assertEq(vault.consecutiveLosses(), 0);
        assertFalse(vault.isHalted());
    }

    function testResumeOnlyOwner() public {
        vault.halt();
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.resume();
        vm.prank(stranger);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.resume();
    }

    function testResumeRestoresTrading() public {
        target.setReturn(0.4 ether);
        vm.startPrank(agent);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        vm.stopPrank();
        assertTrue(vault.isHalted());
        vault.resume();
        assertFalse(vault.isHalted());
        assertEq(vault.consecutiveLosses(), 0);
        target.setReturn(0.6 ether);
        vm.prank(agent);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        assertEq(vault.tradeCount(), 4);
    }

    // ---------- owner-only functions ----------

    function testSetPolicyOnlyOwner() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setPolicy(1 ether, 4 ether, block.timestamp + 14 days, 5);
        vault.setPolicy(1 ether, 4 ether, block.timestamp + 14 days, 5);
        assertEq(vault.maxPerTrade(), 1 ether);
        assertEq(vault.dailyLimit(), 4 ether);
    }

    function testSetAgentOnlyOwner() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setAgent(stranger);
        vault.setAgent(stranger);
        assertEq(vault.agent(), stranger);
    }

    function testWithdrawOnlyOwner() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.withdraw(1 ether, agent);
        uint256 before = address(this).balance;
        vault.withdraw(1 ether, owner);
        assertEq(address(this).balance, before + 1 ether);
        assertEq(address(vault).balance, 9 ether);
    }

    function testAgentCannotHaltOrManageTargets() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.halt();
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.addTarget(stranger);
    }

    function testApproveTokenOnlyOwnerAndAllowlisted() public {
        token = new TestToken(1_000_000 ether);
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.approveToken(address(token), address(target), 1 ether);
        vm.expectRevert(AgentVault.TargetNotAllowed.selector);
        vault.approveToken(address(token), stranger, 1 ether);
        vault.approveToken(address(token), address(target), 1 ether);
        assertEq(token.allowance(address(vault), address(target)), 1 ether);
    }

    // ---------- reentrancy ----------

    function testReentrancyBlocked() public {
        // The malicious target IS the agent: it tries to re-enter
        // executeTrade mid-call. The guard must block it.
        MockTarget evil = new MockTarget();
        AgentVault v2 =
            new AgentVault(address(evil), MAX_PER_TRADE, DAILY_LIMIT, block.timestamp + 7 days, MAX_LOSSES);
        evil.setVault(address(v2));
        evil.setReturn(0.6 ether);
        v2.addTarget(address(evil));
        v2.deposit{value: 10 ether}();
        vm.prank(address(evil));
        v2.executeTrade(address(evil), abi.encodeWithSignature("tradeReenter()"), 0.5 ether, 0);
        assertFalse(evil.reentered());
        assertEq(v2.tradeCount(), 1);
        assertEq(address(v2).balance, 9.5 ether);
    }

    // ---------- rolling window ----------

    function testRollingWindowExpires() public {
        vm.prank(agent);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        assertEq(vault.spentLast24h(), 0.5 ether);
        vm.warp(block.timestamp + 24 hours + 1);
        assertEq(vault.spentLast24h(), 0);
        vm.prank(agent);
        vault.executeTrade(address(target), abi.encodeWithSignature("trade()"), 0.5 ether, 0);
        assertEq(vault.spentLast24h(), 0.5 ether);
    }

    // ---------- full arbitrage flow against real pools ----------

    function testArbitrageFlowTwoPools() public {
        token = new TestToken(1_000_000 ether);
        poolA = new SimplePool(address(token));
        poolB = new SimplePool(address(token));
        vault.addTarget(address(poolA));
        vault.addTarget(address(poolB));
        vault.approveToken(address(token), address(poolA), type(uint256).max);
        vault.approveToken(address(token), address(poolB), type(uint256).max);

        // Seed: pool A QAT cheap (3.5 QOR / 3.85 QAT = 1.10 QAT/QOR),
        // pool B QAT expensive (3.5 QOR / 3.15 QAT = 0.90 QAT/QOR) — a real
        // ~20% marginal cross-pool spread. Pools are deep relative to the
        // 0.2 QOR trade (~6% of reserves) so price impact does not eat the
        // spread; a 0.4 QOR trade against 2 QOR pools would lose to impact.
        token.approve(address(poolA), 3.85 ether);
        poolA.addLiquidity{value: 3.5 ether}(3.85 ether);
        token.approve(address(poolB), 3.15 ether);
        poolB.addLiquidity{value: 3.5 ether}(3.15 ether);

        uint256 vaultQorBefore = address(vault).balance;

        // Leg 1 (buy): 0.2 QOR -> QAT on pool A (cheap).
        uint256 expectedQat = poolA.getAmountOut(0.2 ether, true);
        vm.prank(agent);
        vault.executeTrade(
            address(poolA), abi.encodeWithSignature("swapQorForToken(uint256)", 0), 0.2 ether, 0
        );
        uint256 qatHeld = token.balanceOf(address(vault));
        assertEq(qatHeld, expectedQat);
        assertGt(qatHeld, 0.2 ether); // bought cheap: more QAT than QOR paid

        // Leg 2 (sell): all QAT -> QOR on pool B (expensive). The QAT
        // amount must stay under the per-trade cap (0.5) — the agent sizes
        // the buy leg so this holds.
        assertLe(qatHeld, MAX_PER_TRADE);
        uint256 expectedQor = poolB.getAmountOut(qatHeld, false);
        vm.prank(agent);
        vault.executeTrade(
            address(poolB),
            abi.encodeWithSignature("swapTokenForQor(uint256,uint256)", qatHeld, 0),
            qatHeld,
            0
        );
        uint256 vaultQorAfter = address(vault).balance;
        assertEq(token.balanceOf(address(vault)), 0);
        assertGt(vaultQorAfter, vaultQorBefore); // real arbitrage profit
        assertEq(vault.tradeCount(), 2);
        emit log_named_uint("arbitrage profit (wei)", vaultQorAfter - vaultQorBefore);
        emit log_named_uint("expected sell proceeds (wei)", expectedQor);
    }

    receive() external payable {}
}
