use anchor_lang::prelude::*;

use crate::math::MathError;

#[error_code]
pub enum GgError {
    #[msg("Trading and market creation are paused")]
    Paused,
    #[msg("This feature is not enabled in this program version")]
    NotEnabledInThisVersion,
    #[msg("Signer is not the config admin")]
    NotAdmin,
    #[msg("Signer is not the program upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Invalid config parameter")]
    InvalidConfig,
    #[msg("Collateral mint must be an initialized 6 decimal SPL Token mint")]
    InvalidCollateralMint,
    #[msg("Feed symbol is empty or too long")]
    InvalidSymbol,
    #[msg("Price feed is not on the allowlist")]
    FeedNotAllowed,
    #[msg("Target price must be positive and the exponent in [-18, 0]")]
    InvalidTarget,
    #[msg("Base fee must be 50, 100 or 200 bps")]
    InvalidBaseFee,
    #[msg("Opening price must be between 2% and 98%")]
    InvalidOpeningPrice,
    #[msg("Liquidity is below the configured minimum")]
    LiquidityTooLow,
    #[msg("Settlement is sooner than the minimum duration")]
    DurationTooShort,
    #[msg("Settlement is later than the maximum duration")]
    DurationTooLong,
    #[msg("Collateral mint does not match the config")]
    WrongCollateralMint,
    #[msg("Token account or mint does not match the market")]
    WrongMint,
    #[msg("Vault does not match the market")]
    WrongVault,
    #[msg("Token account owner or mint is wrong")]
    WrongTokenAccount,
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Trading has ended for this market")]
    TradingEnded,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Buy is below the 1 USDC minimum")]
    BelowMinTrade,
    #[msg("Sell returns less than the 0.01 USDC minimum")]
    SellTooSmall,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Reserves would exceed the supported maximum")]
    ReserveTooLarge,
    #[msg("Pool reserves are empty")]
    ReserveEmpty,
    #[msg("Settlement time has not been reached")]
    TooEarlyToSettle,
    #[msg("Void grace period has not elapsed")]
    TooEarlyToVoid,
    #[msg("Price update feed id does not match the market")]
    WrongFeedId,
    #[msg("Price update is not fully verified")]
    InsufficientVerification,
    #[msg("Price update was published before the settlement time")]
    PriceStale,
    #[msg("Price update was published after the settlement window")]
    PriceOutsideWindow,
    #[msg("Oracle price must be positive")]
    NonPositivePrice,
    #[msg("Oracle confidence interval is too wide")]
    ConfidenceTooWide,
    #[msg("Oracle exponent is out of range")]
    ExponentOutOfRange,
    #[msg("Market is not settled or voided")]
    NotResolved,
    #[msg("Only the winning side can be redeemed")]
    NotWinningSide,
    #[msg("Amount is too small to pay out")]
    AmountTooSmall,
    #[msg("Invalid LP amount")]
    InvalidLpAmount,
    #[msg("Accounting invariant violated")]
    InvariantViolated,
}

impl From<MathError> for GgError {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Overflow | MathError::SellRootFailed => GgError::MathOverflow,
            MathError::ZeroAmount => GgError::ZeroAmount,
            MathError::ReserveEmpty => GgError::ReserveEmpty,
            MathError::ReserveTooLarge => GgError::ReserveTooLarge,
            MathError::InvalidP0 => GgError::InvalidOpeningPrice,
            MathError::ExponentOutOfRange => GgError::ExponentOutOfRange,
        }
    }
}

/// Map a pure-math error to an Anchor error in `?` position.
pub trait MathResultExt<T> {
    fn gg(self) -> Result<T>;
}

impl<T> MathResultExt<T> for core::result::Result<T, MathError> {
    fn gg(self) -> Result<T> {
        self.map_err(|e| error!(GgError::from(e)))
    }
}
