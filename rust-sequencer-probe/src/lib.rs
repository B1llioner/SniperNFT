pub mod config;
pub mod probe;

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Distribution {
    pub count: usize,
    pub min: Option<f64>,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub p99: Option<f64>,
    pub max: Option<f64>,
}

/// Nearest-rank percentiles, matching the JavaScript benchmark.
pub fn distribution(values: impl Iterator<Item = f64>) -> Distribution {
    let mut values: Vec<f64> = values.filter(|value| value.is_finite()).collect();
    values.sort_by(f64::total_cmp);
    let rank = |percent: usize| {
        let index = (values.len() * percent).div_ceil(100).checked_sub(1)?;
        values.get(index).copied()
    };
    Distribution {
        count: values.len(),
        min: values.first().copied(),
        p50: rank(50),
        p95: rank(95),
        p99: rank(99),
        max: values.last().copied(),
    }
}

#[cfg(test)]
mod tests {
    use super::distribution;

    #[test]
    fn percentiles_use_nearest_rank_and_empty_is_not_zero() {
        let sample = distribution((1..=100).map(f64::from));
        assert_eq!(sample.p50, Some(50.0));
        assert_eq!(sample.p95, Some(95.0));
        assert_eq!(sample.p99, Some(99.0));
        assert_eq!(distribution([].into_iter()).p50, None);
    }
}
