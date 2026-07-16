import { expect, test } from "bun:test";
import { classifyBarcode, incrementBarcode } from "./barcode.ts";

test("valid 12-digit barcodes are kept", () => {
  expect(classifyBarcode("123456789012")).toEqual({ kind: "valid" });
  expect(classifyBarcode("000000000001")).toEqual({ kind: "valid" });
});

test("empty or missing barcodes need generation", () => {
  expect(classifyBarcode("")).toEqual({ kind: "empty" });
  expect(classifyBarcode("   ")).toEqual({ kind: "empty" });
  expect(classifyBarcode(undefined)).toEqual({ kind: "empty" });
  expect(classifyBarcode(null)).toEqual({ kind: "empty" });
});

test("too short barcodes are padded with 72 and zeroes", () => {
  expect(classifyBarcode("12345678")).toEqual({
    kind: "fixable",
    fixed: "720012345678",
  });
  expect(classifyBarcode("5")).toEqual({
    kind: "fixable",
    fixed: "720000000005",
  });
  expect(classifyBarcode("1234567890")).toEqual({
    kind: "fixable",
    fixed: "721234567890",
  });
});

test("11-digit barcodes are trimmed to 10 and prefixed with 72", () => {
  expect(classifyBarcode("12345678901")).toEqual({
    kind: "fixable",
    fixed: "722345678901",
  });
});

test("text is stripped, then padded if needed", () => {
  expect(classifyBarcode("ABC12345678")).toEqual({
    kind: "fixable",
    fixed: "720012345678",
  });
  expect(classifyBarcode("X123456789012")).toEqual({
    kind: "fixable",
    fixed: "123456789012",
  });
});

test("too long barcodes keep the rightmost 10 digits, prefixed with 72", () => {
  expect(classifyBarcode("9876123456789012")).toEqual({
    kind: "fixable",
    fixed: "723456789012",
  });
});

test("barcodes without digits are unfixable", () => {
  expect(classifyBarcode("NO-BARCODE")).toEqual({ kind: "unfixable" });
});

test("incrementBarcode increases and keeps zero padding", () => {
  expect(incrementBarcode("710000000009")).toBe("710000000010");
  expect(incrementBarcode("000000000001")).toBe("000000000002");
  expect(() => incrementBarcode("999999999999")).toThrow();
});
