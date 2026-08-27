import { describe, expect, it } from "vitest";
import { MentionVisibilityClass } from "@igtrack/core";
import { classifyMentionVisibility } from "../src/normalize/mention.js";

const canvas = { canvasWidth: 1080, canvasHeight: 1920 };

describe("classifyMentionVisibility", () => {
  it("explicit is_hidden=true wins over everything", () => {
    expect(
      classifyMentionVisibility({
        isHidden: true,
        geometry: { x: 100, y: 100, width: 50, height: 20, ...canvas },
      }),
    ).toBe(MentionVisibilityClass.POSSIBLY_HIDDEN);
  });

  it("box fully inside canvas is VISIBLE", () => {
    expect(
      classifyMentionVisibility({
        geometry: { x: 420, y: 1500, width: 240, height: 60, ...canvas },
      }),
    ).toBe(MentionVisibilityClass.VISIBLE);
  });

  it("box fully outside canvas is OFF_CANVAS", () => {
    expect(
      classifyMentionVisibility({
        geometry: { x: 2500, y: 100, width: 200, height: 50, ...canvas },
      }),
    ).toBe(MentionVisibilityClass.OFF_CANVAS);
    expect(
      classifyMentionVisibility({
        geometry: { x: -300, y: -100, width: 200, height: 50, ...canvas },
      }),
    ).toBe(MentionVisibilityClass.OFF_CANVAS);
  });

  it("box overlapping canvas edge stays VISIBLE", () => {
    expect(
      classifyMentionVisibility({
        geometry: { x: 1000, y: 100, width: 200, height: 50, ...canvas },
      }),
    ).toBe(MentionVisibilityClass.VISIBLE);
  });

  it("coordinates without canvas reference cannot be classified", () => {
    expect(
      classifyMentionVisibility({
        geometry: { x: 10, y: 10, width: 50, height: 20 },
      }),
    ).toBe(MentionVisibilityClass.UNKNOWN);
  });

  it("explicit is_hidden=false without geometry is VISIBLE", () => {
    expect(classifyMentionVisibility({ isHidden: false })).toBe(
      MentionVisibilityClass.VISIBLE,
    );
  });

  it("mention with no visibility signals is METADATA_ONLY", () => {
    expect(classifyMentionVisibility({})).toBe(
      MentionVisibilityClass.METADATA_ONLY,
    );
  });
});
