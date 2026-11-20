//! Cross-contract integration suite. One test binary, split by concern.
//!
//! Every test registers the REAL `MeridianVault`, `MusdcToken` and
//! `MeridianBlendAdapter` (see `common::Fixture`) and drives them under
//! enforcing authorization: each root call carries only the signature a real
//! transaction would, so a missing or mis-shaped authorization tree fails the
//! test instead of being papered over by `mock_all_auths`.

mod common;

mod deposit_withdraw;
mod fees;
mod migration;
mod multi_user;
mod pause_and_auth;
mod previews;
mod transfer;
