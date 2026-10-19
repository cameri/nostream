//! Parity with `test/unit/utils/proof-of-work.spec.ts` (17 mocha cases, measured green at
//! the capture commit `242a3001`): one case per row of the `forEach` table, named after the
//! mocha title `returns <n> given <hex>`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use nostream_core::pow::leading_zero_bits;

#[test]
fn returns_0_given_80() {
    assert_eq!(leading_zero_bits(&[0x80]), 0);
}

#[test]
fn returns_1_given_40() {
    assert_eq!(leading_zero_bits(&[0x40]), 1);
}

#[test]
fn returns_2_given_20() {
    assert_eq!(leading_zero_bits(&[0x20]), 2);
}

#[test]
fn returns_3_given_10() {
    assert_eq!(leading_zero_bits(&[0x10]), 3);
}

#[test]
fn returns_4_given_08() {
    assert_eq!(leading_zero_bits(&[0x08]), 4);
}

#[test]
fn returns_5_given_04() {
    assert_eq!(leading_zero_bits(&[0x04]), 5);
}

#[test]
fn returns_6_given_02() {
    assert_eq!(leading_zero_bits(&[0x02]), 6);
}

#[test]
fn returns_7_given_01() {
    assert_eq!(leading_zero_bits(&[0x01]), 7);
}

#[test]
fn returns_8_given_0080() {
    assert_eq!(leading_zero_bits(&[0x00, 0x80]), 8);
}

#[test]
fn returns_9_given_0040() {
    assert_eq!(leading_zero_bits(&[0x00, 0x40]), 9);
}

#[test]
fn returns_10_given_0020() {
    assert_eq!(leading_zero_bits(&[0x00, 0x20]), 10);
}

#[test]
fn returns_11_given_0010() {
    assert_eq!(leading_zero_bits(&[0x00, 0x10]), 11);
}

#[test]
fn returns_12_given_0008() {
    assert_eq!(leading_zero_bits(&[0x00, 0x08]), 12);
}

#[test]
fn returns_13_given_0004() {
    assert_eq!(leading_zero_bits(&[0x00, 0x04]), 13);
}

#[test]
fn returns_14_given_0002() {
    assert_eq!(leading_zero_bits(&[0x00, 0x02]), 14);
}

#[test]
fn returns_15_given_0001() {
    assert_eq!(leading_zero_bits(&[0x00, 0x01]), 15);
}

#[test]
fn returns_16_given_0000() {
    assert_eq!(leading_zero_bits(&[0x00, 0x00]), 16);
}
