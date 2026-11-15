// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/SimplePool.sol";
import "../src/TestToken.sol";

contract SimplePoolTest is Test {
    TestToken public token;
    SimplePool public pool;

    function setUp() public {
        token = new TestToken(1_000_000 ether);
        pool = new SimplePool(address(token));
        token.approve(address(pool), type(uint256).max);
    }

    function testAddLiquiditySetsReserves() public {
        uint256 shares = pool.addLiquidity{value: 2 ether}(2.2 ether);
        assertGt(shares, 0);
        (uint256 qor, uint256 tok) = pool.getReserves();
        assertEq(qor, 2 ether);
        assertEq(tok, 2.2 ether);
    }

    function testQuoteMatchesSwap() public {
        pool.addLiquidity{value: 2 ether}(2.2 ether);
        uint256 quote = pool.getAmountOut(0.4 ether, true);
        uint256 out = pool.swapQorForToken{value: 0.4 ether}(0);
        assertEq(out, quote);
        assertEq(token.balanceOf(address(this)), 1_000_000 ether - 2.2 ether + quote);
    }

    function testRoundTripLosesToFees() public {
        pool.addLiquidity{value: 2 ether}(2 ether);
        uint256 qat = pool.swapQorForToken{value: 0.5 ether}(0);
        uint256 back = pool.swapTokenForQor(qat, 0);
        assertLt(back, 0.5 ether); // 0.3% fee each way + price impact
    }

    function testMinOutReverts() public {
        pool.addLiquidity{value: 2 ether}(2.2 ether);
        uint256 quote = pool.getAmountOut(0.4 ether, true);
        vm.expectRevert(SimplePool.Slippage.selector);
        pool.swapQorForToken{value: 0.4 ether}(quote + 1);
    }

    function testTokenSellRefundsAttachedQor() public {
        pool.addLiquidity{value: 2 ether}(2.2 ether);
        uint256 qat = pool.swapQorForToken{value: 0.4 ether}(0);
        uint256 before = address(this).balance;
        uint256 out = pool.swapTokenForQor{value: 0.44 ether}(qat, 0);
        // Balance change = proceeds only; the attached 0.44 QOR came back.
        assertEq(address(this).balance, before + out);
    }

    function testPricesDifferAcrossPools() public {
        SimplePool poolB = new SimplePool(address(token));
        token.approve(address(poolB), type(uint256).max);
        pool.addLiquidity{value: 2 ether}(2.2 ether); // QAT cheap
        poolB.addLiquidity{value: 2 ether}(1.8 ether); // QAT expensive
        assertGt(pool.priceTokenPerQor(), poolB.priceTokenPerQor());
        // Buy leg on A yields more QAT per QOR than on B.
        assertGt(pool.getAmountOut(0.4 ether, true), poolB.getAmountOut(0.4 ether, true));
    }

    receive() external payable {}
}
