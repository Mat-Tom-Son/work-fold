//! Native portal, media and emulated-input adapters. These APIs carry no app,
//! Chat or approval policy. The host owns setup and accepted-turn authority.
pub mod ei;
pub mod capture;
pub mod portal;
pub mod seat;
mod keyboard;
