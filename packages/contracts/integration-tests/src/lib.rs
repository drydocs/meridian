#![no_std]

//! Cross-contract integration tests for Meridian.
//!
//! This crate ships no contract code. Everything lives under `tests/`, where
//! the real `MeridianVault`, `MusdcToken` and `MeridianBlendAdapter` are
//! registered together against a controllable mock Blend pool and driven with
//! enforcing (not blanket-mocked) authorization.
//!
//! Why a separate crate: the vault's unit tests stand in `MockMusdc` /
//! `MockAdapter`, and the mUSDC tests stand in a `MockVault`, so no other test
//! exercises the real contracts' wiring, authorization trees and the mUSDC
//! transfer callback into the vault together.
