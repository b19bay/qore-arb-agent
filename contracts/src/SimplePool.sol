// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Minimal {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title SimplePool
/// @notice Minimal constant-product AMM pool: native QOR <-> one ERC-20.
///         Same curve and fee as QoreChain's native x/amm `constant_product`
///         pools (x*y=k, 0.3% swap fee = 30 bps) — see AMM-RESEARCH.md.
///         Demo pools only: deployed by us on the devnet because x/amm is
///         Cosmos-lane only and cannot be called from an EVM vault, and no
///         EVM pool contract exists on the devnet.
/// @dev QOR passthrough on swapTokenForQor: the vault's executeTrade always
///      attaches `valueIn` QOR (its single accounting parameter). On a
///      token-sell leg that QOR is not spent, so the pool refunds it in full
///      to the caller. This keeps the vault's 4-argument interface exact
///      while letting one parameter express both legs of an arbitrage.
contract SimplePool {
    uint256 public constant FEE_BPS = 30; // 0.30%, mirrors x/amm swap_fee_bps
    uint256 public constant MIN_LIQUIDITY = 1000;

    IERC20Minimal public immutable token;

    uint256 public reserveQor;
    uint256 public reserveToken;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    event LiquidityAdded(address indexed provider, uint256 qorIn, uint256 tokenIn, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 qorOut, uint256 tokenOut, uint256 shares);
    event Swap(address indexed sender, bool qorIn, uint256 amountIn, uint256 amountOut);

    error Reentrant();
    error ZeroAmount();
    error InsufficientLiquidity();
    error Slippage();
    error TransferFailed();

    uint256 private _locked;

    modifier nonReentrant() {
        if (_locked == 1) revert Reentrant();
        _locked = 1;
        _;
        _locked = 0;
    }

    constructor(address token_) {
        require(token_ != address(0), "SimplePool: zero token");
        token = IERC20Minimal(token_);
    }

    /// @notice Add liquidity. First deposit sets the price; later deposits
    ///         must keep the pool ratio (shares = min of both sides).
    function addLiquidity(uint256 tokenAmount) external payable nonReentrant returns (uint256 shares) {
        if (msg.value == 0 || tokenAmount == 0) revert ZeroAmount();
        if (totalShares == 0) {
            shares = _sqrt(msg.value * tokenAmount) - MIN_LIQUIDITY;
            totalShares = MIN_LIQUIDITY; // permanently locked dust
        } else {
            uint256 sharesQor = (msg.value * totalShares) / reserveQor;
            uint256 sharesToken = (tokenAmount * totalShares) / reserveToken;
            shares = sharesQor < sharesToken ? sharesQor : sharesToken;
        }
        require(shares > 0, "SimplePool: zero shares");
        if (!token.transferFrom(msg.sender, address(this), tokenAmount)) revert TransferFailed();
        reserveQor += msg.value;
        reserveToken += tokenAmount;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit LiquidityAdded(msg.sender, msg.value, tokenAmount, shares);
    }

    function removeLiquidity(uint256 shares) external nonReentrant returns (uint256 qorOut, uint256 tokenOut) {
        require(shares > 0 && sharesOf[msg.sender] >= shares, "SimplePool: bad shares");
        qorOut = (shares * reserveQor) / totalShares;
        tokenOut = (shares * reserveToken) / totalShares;
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        reserveQor -= qorOut;
        reserveToken -= tokenOut;
        if (!token.transfer(msg.sender, tokenOut)) revert TransferFailed();
        (bool ok,) = payable(msg.sender).call{value: qorOut}("");
        if (!ok) revert TransferFailed();
        emit LiquidityRemoved(msg.sender, qorOut, tokenOut, shares);
    }

    /// @notice Swap native QOR -> token. Returns token amount out.
    function swapQorForToken(uint256 minOut) external payable nonReentrant returns (uint256 amountOut) {
        if (msg.value == 0) revert ZeroAmount();
        amountOut = getAmountOut(msg.value, true);
        if (amountOut < minOut) revert Slippage();
        if (amountOut >= reserveToken) revert InsufficientLiquidity();
        reserveQor += msg.value;
        reserveToken -= amountOut;
        if (!token.transfer(msg.sender, amountOut)) revert TransferFailed();
        emit Swap(msg.sender, true, msg.value, amountOut);
    }

    /// @notice Swap token -> native QOR. Returns QOR amount out.
    /// @dev Refunds any attached QOR in full (see contract notice).
    function swapTokenForQor(uint256 tokenIn, uint256 minOut) external payable nonReentrant returns (uint256 amountOut) {
        if (tokenIn == 0) revert ZeroAmount();
        amountOut = getAmountOut(tokenIn, false);
        if (amountOut < minOut) revert Slippage();
        if (amountOut >= reserveQor) revert InsufficientLiquidity();
        if (!token.transferFrom(msg.sender, address(this), tokenIn)) revert TransferFailed();
        reserveToken += tokenIn;
        reserveQor -= amountOut;
        if (msg.value > 0) {
            (bool okRefund,) = payable(msg.sender).call{value: msg.value}("");
            if (!okRefund) revert TransferFailed();
        }
        (bool ok,) = payable(msg.sender).call{value: amountOut}("");
        if (!ok) revert TransferFailed();
        emit Swap(msg.sender, false, tokenIn, amountOut);
    }

    /// @notice Constant-product quote with the 0.3% fee applied to the input.
    function getAmountOut(uint256 amountIn, bool qorIn) public view returns (uint256 amountOut) {
        if (amountIn == 0) return 0;
        uint256 amountInAfterFee = (amountIn * (10_000 - FEE_BPS)) / 10_000;
        if (qorIn) {
            if (reserveQor == 0 || reserveToken == 0) return 0;
            amountOut = (amountInAfterFee * reserveToken) / (reserveQor + amountInAfterFee);
        } else {
            if (reserveQor == 0 || reserveToken == 0) return 0;
            amountOut = (amountInAfterFee * reserveQor) / (reserveToken + amountInAfterFee);
        }
    }

    function getReserves() external view returns (uint256 qor, uint256 tokenAmount) {
        return (reserveQor, reserveToken);
    }

    /// @notice Price of 1 QOR in token units, scaled by 1e18.
    function priceTokenPerQor() external view returns (uint256) {
        if (reserveQor == 0) return 0;
        return (reserveToken * 1e18) / reserveQor;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
