// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title AgentVault
/// @notice Vault that holds an autonomous agent's funds and enforces EVERY
///         limit on-chain: per-trade cap, rolling 24h daily cap, target
///         allowlist, authorisation expiry, and auto-halt on consecutive
///         losses or on daily-budget exhaustion. The agent can ONLY execute
///         trades through this contract; it cannot change policy, withdraw
///         funds, or call any target outside the allowlist.
/// @dev P&L accounting: executeTrade decodes the target's uint256 return as
///      `valueOut` and computes pnl = valueOut - valueIn in raw units. This
///      is economically meaningful when the trade's input and output assets
///      are near parity (the demo pools are seeded near 1 QOR = 1 QAT), and
///      it is a conservative safety tripwire, not a pricing oracle: a trade
///      counts as a loss iff valueOut < valueIn. The off-chain agent ALSO
///      records true QOR-denominated P&L in its run log from live pool
///      quotes; the on-chain counter exists to halt a runaway agent.
///      Rolling 24h window: trades are recorded with timestamps; expired
///      entries are pruned lazily on each trade, so `spentLast24h` is a
///      true rolling sum, not a calendar day.
contract AgentVault {
    uint256 public constant WINDOW = 24 hours;

    address public owner;
    address public agent;

    uint256 public maxPerTrade;
    uint256 public dailyLimit;
    uint256 public authExpiry;
    uint256 public maxConsecutiveLosses;

    mapping(address => bool) public allowedTargets;
    bool public halted;
    uint256 public consecutiveLosses;
    uint256 public tradeCount;

    struct Spend {
        uint256 timestamp;
        uint256 amount;
    }

    Spend[] private _spends;
    uint256 private _windowStart;
    uint256 private _spentWindow;

    event Deposited(address indexed from, uint256 amount);
    event TradeExecuted(
        uint256 indexed id, address indexed target, uint256 valueIn, uint256 valueOut, int256 pnl, bool profitable
    );
    event AutoHalted(string reason);
    event Halted(address indexed by);
    event Resumed(address indexed by);
    event PolicyUpdated(uint256 maxPerTrade, uint256 dailyLimit, uint256 authExpiry, uint256 maxConsecutiveLosses);
    event TargetAllowed(address indexed target, bool allowed);
    event AgentChanged(address indexed oldAgent, address indexed newAgent);
    event Withdrawn(address indexed to, uint256 amount);
    event TokenApproved(address indexed token, address indexed spender, uint256 amount);

    error NotOwner();
    error NotAgent();
    error IsHalted();
    error AuthExpired();
    error TargetNotAllowed();
    error ExceedsPerTradeCap();
    error ExceedsDailyLimit();
    error InsufficientBalance();
    error TargetCallFailed();
    error BadReturnData();
    error OutputBelowMinOut();
    error Reentrant();
    error BadPolicy();

    uint256 private _locked;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier nonReentrant() {
        if (_locked == 1) revert Reentrant();
        _locked = 1;
        _;
        _locked = 0;
    }

    constructor(
        address agent_,
        uint256 maxPerTrade_,
        uint256 dailyLimit_,
        uint256 authExpiry_,
        uint256 maxConsecutiveLosses_
    ) {
        if (agent_ == address(0)) revert BadPolicy();
        if (maxPerTrade_ == 0 || dailyLimit_ < maxPerTrade_) revert BadPolicy();
        if (authExpiry_ <= block.timestamp) revert BadPolicy();
        if (maxConsecutiveLosses_ == 0) revert BadPolicy();
        owner = msg.sender;
        agent = agent_;
        maxPerTrade = maxPerTrade_;
        dailyLimit = dailyLimit_;
        authExpiry = authExpiry_;
        maxConsecutiveLosses = maxConsecutiveLosses_;
    }

    /// @notice Anyone may fund the vault.
    function deposit() external payable {
        require(msg.value > 0, "AgentVault: zero deposit");
        emit Deposited(msg.sender, msg.value);
    }

    /// @dev Plain QOR transfers (pool refunds and swap proceeds on sell legs)
    ///      must be accepted or the pool calls would fail — but they are NOT
    ///      deposits, so they deliberately emit NO event. (Revision 2: the
    ///      first deployment emitted Deposited here, which polluted the audit
    ///      log with pool refunds labelled as deposits.)
    receive() external payable {}

    /// @notice Execute one trade through an allowlisted target.
    /// @param target Allowlisted contract to call (e.g. a pool).
    /// @param data Calldata for the target (e.g. swapQorForToken(minOut)).
    ///             The target MUST return a single uint256: the output amount.
    /// @param valueIn Amount at risk in this trade (QOR attached to the call
    ///                and counted against the per-trade and daily caps).
    /// @param minOut Minimum acceptable output; the trade reverts below it.
    function executeTrade(address target, bytes calldata data, uint256 valueIn, uint256 minOut)
        external
        onlyAgent
        nonReentrant
    {
        if (halted) revert IsHalted();
        if (block.timestamp > authExpiry) revert AuthExpired();
        if (!allowedTargets[target]) revert TargetNotAllowed();
        if (valueIn == 0 || valueIn > maxPerTrade) revert ExceedsPerTradeCap();

        _pruneWindow();
        if (_spentWindow + valueIn > dailyLimit) revert ExceedsDailyLimit();
        if (address(this).balance < valueIn) revert InsufficientBalance();

        // Effects before interaction.
        _spentWindow += valueIn;
        _spends.push(Spend({timestamp: block.timestamp, amount: valueIn}));
        uint256 id = ++tradeCount;

        (bool ok, bytes memory ret) = target.call{value: valueIn}(data);
        if (!ok) revert TargetCallFailed();
        if (ret.length < 32) revert BadReturnData();
        uint256 valueOut = abi.decode(ret, (uint256));
        if (valueOut < minOut) revert OutputBelowMinOut();

        bool profitable = valueOut >= valueIn;
        int256 pnl = int256(valueOut) - int256(valueIn);
        if (profitable) {
            consecutiveLosses = 0;
        } else {
            consecutiveLosses += 1;
        }
        emit TradeExecuted(id, target, valueIn, valueOut, pnl, profitable);

        if (consecutiveLosses >= maxConsecutiveLosses) {
            halted = true;
            emit AutoHalted("consecutive losses");
        } else if (_spentWindow >= dailyLimit) {
            halted = true;
            emit AutoHalted("daily budget exhausted");
        }
    }

    /// @notice Owner-only: let an allowlisted target spend vault-held ERC-20
    ///         (needed for token-sell legs). The agent can never approve.
    function approveToken(address token, address spender, uint256 amount) external onlyOwner {
        if (!allowedTargets[spender]) revert TargetNotAllowed();
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        if (!ok) revert TargetCallFailed();
        emit TokenApproved(token, spender, amount);
    }

    function halt() external onlyOwner {
        halted = true;
        emit Halted(msg.sender);
    }

    function resume() external onlyOwner {
        halted = false;
        consecutiveLosses = 0;
        emit Resumed(msg.sender);
    }

    function setPolicy(
        uint256 maxPerTrade_,
        uint256 dailyLimit_,
        uint256 authExpiry_,
        uint256 maxConsecutiveLosses_
    ) external onlyOwner {
        if (maxPerTrade_ == 0 || dailyLimit_ < maxPerTrade_) revert BadPolicy();
        if (authExpiry_ <= block.timestamp) revert BadPolicy();
        if (maxConsecutiveLosses_ == 0) revert BadPolicy();
        maxPerTrade = maxPerTrade_;
        dailyLimit = dailyLimit_;
        authExpiry = authExpiry_;
        maxConsecutiveLosses = maxConsecutiveLosses_;
        emit PolicyUpdated(maxPerTrade_, dailyLimit_, authExpiry_, maxConsecutiveLosses_);
    }

    function addTarget(address target) external onlyOwner {
        require(target != address(0), "AgentVault: zero target");
        allowedTargets[target] = true;
        emit TargetAllowed(target, true);
    }

    function removeTarget(address target) external onlyOwner {
        allowedTargets[target] = false;
        emit TargetAllowed(target, false);
    }

    function setAgent(address agent_) external onlyOwner {
        require(agent_ != address(0), "AgentVault: zero agent");
        address old = agent;
        agent = agent_;
        emit AgentChanged(old, agent_);
    }

    function withdraw(uint256 amount, address to) external onlyOwner nonReentrant {
        require(to != address(0), "AgentVault: zero recipient");
        require(amount <= address(this).balance, "AgentVault: insufficient balance");
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "AgentVault: withdraw failed");
        emit Withdrawn(to, amount);
    }

    /// @notice QOR spent in the last rolling 24 hours.
    function spentLast24h() external view returns (uint256 spent) {
        uint256 cutoff = block.timestamp > WINDOW ? block.timestamp - WINDOW : 0;
        for (uint256 i = _windowStart; i < _spends.length; i++) {
            if (_spends[i].timestamp > cutoff) spent += _spends[i].amount;
        }
    }

    function isHalted() external view returns (bool) {
        return halted;
    }

    function isAllowed(address target) external view returns (bool) {
        return allowedTargets[target];
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    function tokenBalance(address token) external view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    function _pruneWindow() internal {
        uint256 cutoff = block.timestamp > WINDOW ? block.timestamp - WINDOW : 0;
        while (_windowStart < _spends.length && _spends[_windowStart].timestamp <= cutoff) {
            _spentWindow -= _spends[_windowStart].amount;
            _windowStart++;
        }
    }
}
