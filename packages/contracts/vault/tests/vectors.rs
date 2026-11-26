use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Deserialize, Debug)]
struct VectorFile {
    #[allow(dead_code)]
    version: u32,
    #[allow(dead_code)]
    contract_version: Option<String>,
    virtual_offset: String,
    #[allow(dead_code)]
    performance_fee_bps: Option<String>,
    #[allow(dead_code)]
    bps_denominator: Option<String>,
    vectors: Vec<Vector>,
}

#[derive(Deserialize, Debug)]
struct Vector {
    name: String,
    #[allow(dead_code)]
    description: String,
    kind: String,
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
    let path_buf =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../shared/vectors/vault_math_v1.json");
    let data = fs::read_to_string(&path_buf)
        .unwrap_or_else(|_| panic!("Failed to read vault_math_v1.json at {:?}", path_buf));
    let suite: VectorFile = serde_json::from_str(&data).unwrap();

    assert_eq!(
        suite.virtual_offset,
        meridian_vault::storage::OFFSET.to_string()
    );

    for v in suite.vectors {
        match v.kind.as_str() {
            "deposit" | "edge" => {
                let assets = v
                    .inputs
                    .assets
                    .as_deref()
                    .unwrap_or("0")
                    .parse::<i128>()
                    .unwrap();
                let total_shares = v
                    .inputs
                    .total_shares
                    .as_deref()
                    .unwrap_or("0")
                    .parse::<i128>()
                    .unwrap();
                let total_assets = v
                    .inputs
                    .total_assets
                    .as_deref()
                    .unwrap_or("0")
                    .parse::<i128>()
                    .unwrap();
                let shares =
                    meridian_vault::pricing::shares_for_assets(assets, total_shares, total_assets)
                        .unwrap();

                if let Some(expected_shares) = &v.expected.shares_out {
                    assert_eq!(
                        shares,
                        expected_shares.parse::<i128>().unwrap(),
                        "Failed shares_out on vector {}",
                        v.name
                    );
                } else {
                    panic!("Missing expected shares_out for vector {}", v.name);
                }

                if let Some(expected_share_price) = &v.expected.share_price {
                    let share_price = if total_shares == 0 {
                        assets
                    } else {
                        (total_assets * 10_000_000) / total_shares
                    };
                    assert_eq!(
                        share_price,
                        expected_share_price.parse::<i128>().unwrap(),
                        "Failed share_price on vector {}",
                        v.name
                    );
                } else {
                    panic!("Missing expected share_price for vector {}", v.name);
                }
            }
            "withdrawal_payout" => {
                let shares = v
                    .inputs
                    .shares
                    .as_deref()
                    .unwrap_or("0")
                    .parse::<i128>()
                    .unwrap();
                let total_shares = v
                    .inputs
                    .total_shares
                    .as_deref()
                    .unwrap_or("0")
                    .parse::<i128>()
                    .unwrap();
                let total_assets = v
                    .inputs
                    .total_assets
                    .as_deref()
                    .unwrap_or("0")
                    .parse::<i128>()
                    .unwrap();
                let assets = meridian_vault::pricing::assets_for_adapter_shares(
                    shares,
                    total_assets,
                    total_shares,
                )
                .unwrap();

                if let Some(expected_assets) = &v.expected.assets_out {
                    assert_eq!(
                        assets,
                        expected_assets.parse::<i128>().unwrap(),
                        "Failed assets_out on vector {}",
                        v.name
                    );
                } else {
                    panic!("Missing expected assets_out for vector {}", v.name);
                }
            }
            "fee" | "loss_withdrawal" => {
                let usdc_out = v
                    .inputs
                    .usdc_out
                    .as_deref()
                    .unwrap_or("0")
                    .parse::<i128>()
                    .unwrap();
                let principal_out = v
                    .inputs
                    .principal_out
                    .as_deref()
                    .unwrap_or("0")
                    .parse::<i128>()
                    .unwrap();
                let fee_bps = v
                    .inputs
                    .fee_bps
                    .as_deref()
                    .unwrap_or("0")
                    .parse::<i128>()
                    .unwrap();
                let bps_denom = v
                    .inputs
                    .bps_denominator
                    .as_deref()
                    .unwrap_or("10000")
                    .parse::<i128>()
                    .unwrap();

                let (gain, fee) = meridian_vault::pricing::performance_fee(
                    usdc_out,
                    principal_out,
                    fee_bps,
                    bps_denom,
                )
                .unwrap();

                if let Some(expected_gain) = &v.expected.gain {
                    assert_eq!(
                        gain,
                        expected_gain.parse::<i128>().unwrap(),
                        "Failed gain on {}",
                        v.name
                    );
                } else {
                    panic!("Missing expected gain for vector {}", v.name);
                }

                if let Some(expected_fee) = &v.expected.fee {
                    assert_eq!(
                        fee,
                        expected_fee.parse::<i128>().unwrap(),
                        "Failed fee on {}",
                        v.name
                    );
                } else {
                    panic!("Missing expected fee for vector {}", v.name);
                }
            }
            other => {
                panic!("Unknown vector kind '{}' for vector {}", other, v.name);
            }
        }
    }
}
