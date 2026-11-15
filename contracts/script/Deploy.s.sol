// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/TestToken.sol";
import "../src/SimplePool.sol";
import "../src/AgentVault.sol";

/// @notice Deploys the full demo stack on the devnet and wires it up:
///         TestToken + two SimplePools seeded at divergent prices + the
///         AgentVault (owner = deployer, agent from $AGENT_ADDRESS).
///         Run: forge script script/Deploy.s.sol --rpc-url http://localhost:8545
///              --broadcast --private-key $OWNER_PRIVATE_KEY
///         Requires the deployer's EVM window to be open (see README).
contract Deploy is Script {
    function run() external {
        address agentAddr = vm.envAddress("AGENT_ADDRESS");
        uint256 deployerKey = vm.envUint("OWNER_PRIVATE_KEY");

        // Fail fast if the deployer cannot fund the whole plan (7 QOR seed
        // + 1.5 QOR deposit + ~1 QOR gas buffer). Without this, forge
        // broadcasts the early txs and silently drops the deposit when the
        // deployer runs dry mid-script (observed on the v2 devnet deploy).
        address deployer = vm.addr(deployerKey);
        require(deployer.balance >= 9.5 ether, "Deploy: deployer needs >= 9.5 QOR");

        vm.startBroadcast(deployerKey);

        TestToken token = new TestToken(1_000_000 ether);
        SimplePool poolA = new SimplePool(address(token));
        SimplePool poolB = new SimplePool(address(token));
        AgentVault vault = new AgentVault(
            agentAddr,
            0.5 ether, // maxPerTrade
            2 ether, // dailyLimit
            block.timestamp + 7 days, // authExpiry
            3 // maxConsecutiveLosses
        );

        vault.addTarget(address(poolA));
        vault.addTarget(address(poolB));
        vault.approveToken(address(token), address(poolA), type(uint256).max);
        vault.approveToken(address(token), address(poolB), type(uint256).max);

        // Seed pool A cheap (1 QOR = 1.10 QAT) and pool B expensive
        // (1 QOR = 0.90 QAT): a real ~20% marginal cross-pool spread.
        token.approve(address(poolA), 3.85 ether);
        poolA.addLiquidity{value: 3.5 ether}(3.85 ether);
        token.approve(address(poolB), 3.15 ether);
        poolB.addLiquidity{value: 3.5 ether}(3.15 ether);

        vault.deposit{value: 1.5 ether}();

        vm.stopBroadcast();

        console.log("TestToken:", address(token));
        console.log("PoolA (cheap QAT):", address(poolA));
        console.log("PoolB (expensive QAT):", address(poolB));
        console.log("AgentVault:", address(vault));
        console.log("Agent:", agentAddr);
        console.log("Owner:", vm.addr(deployerKey));
    }
}
