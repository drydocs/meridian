// Pure functions for rebalance-to-neutral trigger and order computation
// Uses FixedPointDecimal throughout to ensure deterministic delta math

pub struct PositionState {
    pub net_delta: FixedPointDecimal,
    pub notional: FixedPointDecimal,
}

pub struct FixedPointDecimal {
    pub value: i128, // Fixed-point representation
}

impl FixedPointDecimal {
    pub fn abs(&self) -> Self {
        Self { value: self.value.abs() }
    }
}

/// Determines if the absolute net delta exceeds the configured band fraction of notional
pub fn shouldRebalance(state: &PositionState, band: &FixedPointDecimal) -> bool {
    let allowed_drift = state.notional.value * band.value;
    state.net_delta.abs().value > allowed_drift
}

/// Computes the hedge adjustment needed to restore neutrality to target
pub fn computeRebalanceOrder(state: &PositionState, target: &FixedPointDecimal) -> FixedPointDecimal {
    let adjustment = state.net_delta.value - target.value;
    FixedPointDecimal { value: -adjustment }
}
