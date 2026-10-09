import { describe, expect, test } from "vitest";
import { formatProvenance, getProvenanceFormatter } from "../companion/provenance";

describe("provenance cached formatter", () => {
  test("formats en date like toLocaleDateString", () => {
    const created = "2026-10-01T12:00:00.000Z";
    const expected = new Date(created).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    expect(formatProvenance("on {date}", "en", created)).toBe(`on ${expected}`);
  });

  test("formats ar date with arabic locale tag", () => {
    const created = "2026-10-01T12:00:00.000Z";
    const expected = new Date(created).toLocaleDateString("ar-EG-u-nu-latn", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    expect(formatProvenance("بتاريخ {date}", "ar", created)).toBe(`بتاريخ ${expected}`);
  });

  test("keeps raw timestamp when date is invalid", () => {
    expect(formatProvenance("on {date}", "en", "not-a-date")).toBe("on not-a-date");
  });

  test("reuses formatter instance per locale", () => {
    expect(getProvenanceFormatter("en")).toBe(getProvenanceFormatter("en"));
    expect(getProvenanceFormatter("ar")).toBe(getProvenanceFormatter("ar"));
  });
});
