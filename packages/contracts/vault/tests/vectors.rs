use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Deserialize, Debug)]
struct VectorFile {
    version: u32,
    virtual_offset: String,
    vectors: Vec<Vector>,
}

#[derive(Deserialize, Debug)]
struct Vector {
    name: String,
    inputs: VectorInputs,
    expected: VectorExpected,
}

#[derive(Deserialize, Debug)]
struct VectorInputs {
    assets: Option<String>,
    total_assets: Option<String>,
    total_shares: Option<String>,
    shares: Option<String>,
    usdc_out: Option<String>,
    principal_out: Option<String>,
    fee_bps: Option<String>,
    bps_denominator: Option<String>,
}

#[derive(Deserialize, Debug)]
struct VectorExpected {
    shares_out: Option<String>,
    share_price: Option<String>,
    assets_out: Option<String>,
    gain: Option<String>,
    fee: Option<String>,
}

#[test]
fn test_vault_math_conformance_vectors() {
    let path_str = "../../shared/vectors/vault_math_v1.json";
    let data = fs::read_to_string(path_str)
        .unwrap_or_else(|_| fs::read_to_string("packages/shared/vectors/vault_math_v1.json").unwrap());
    let suite: VectorFile = serde_json::from_str(&data).unwrap();

    assert_eq!(suite.virtual_offset, meridian_vault::storage::OFFSET.to_string());

    for v in suite.vectors {
        if v.name.contains("deposit") || v.name.contains("edge") {
            let assets = v.inputs.assets.as_deref().unwrap_or("0").parse::<i128>().unwrap();
            let total_shares = v.inputs.total_shares.as_deref().unwrap_or("0").parse::<i128>().unwrap();
            let total_assets = v.inputs.total_assets.as_deref().unwrap_or("0").parse::<i128>().unwrap();
            let shares = meridian_vault::pricing::shares_for_assets(assets, total_shares, total_assets).unwrap();
            if let Some(expected_shares) = &v.expected.shares_out {
                assert_eq!(shares, expected_shares.parse::<i128>().unwrap(), "Failed on vector {}", v.name);
            }
        } else if v.name.contains("withdrawal_payout") {
            let shares = v.inputs.shares.as_deref().unwrap_or("0").parse::<i128>().unwrap();
            let total_shares = v.inputs.total_shares.as_deref().unwrap_or("0").parse::<i128>().unwrap();
            let total_assets = v.inputs.total_assets.as_deref().unwrap_or("0").parse::<i128>().unwrap();
            // raw ratio or adapter shares
            let adapter_shares = shares; // 1:1 in test vectors
            let assets = meridian_vault::pricing::assets_for_adapter_shares(adapter_shares, total_assets, total_shares).unwrap();
            if let Some(expected_assets) = &v.expected.assets_out {
                assert_eq!(assets, expected_assets.parse::<i128>().unwrap(), "Failed on vector {}", v.name);
            }
        } else if v.name.contains("fee") || v.name.contains("loss_withdrawal") {
            let usdc_out = v.inputs.usdc_out.as_deref().unwrap_or("0").parse::<i128>().unwrap();
            let principal_out = v.inputs.principal_out.as_deref().unwrap_or("0").parse::<i128>().unwrap();
            let fee_bps = v.inputs.fee_bps.as_deref().unwrap_or("0").parse::<i128>().unwrap();
            let bps_denom = v.inputs.bps_denominator.as_deref().unwrap_or("10000").parse::<i128>().unwrap();

            let (gain, fee) = meridian_vault::pricing::performance_fee(usdc_out, principal_out, fee_bps, bps_denom).unwrap();
            if let Some(expected_gain) = &v.expected.gain {
                assert_eq!(gain, expected_gain.parse::<i128>().unwrap(), "Failed gain on {}", v.name);
            }
            if let Some(expected_fee) = &v.expected.fee {
                assert_eq!(fee, expected_fee.parse::<i128>().unwrap(), "Failed fee on {}", v.name);
            }
        }
    }
}
