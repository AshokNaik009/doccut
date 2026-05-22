// JSON schemas passed to `claude -p --json-schema`. See SPEC §5.2, §5.3.

/** Selection schema for the extract select step (SPEC §5.2). */
export const SELECTION_SCHEMA = {
  type: "object",
  required: ["selections"],
  additionalProperties: false,
  properties: {
    selections: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "startPage", "endPage", "confidence"],
        additionalProperties: false,
        properties: {
          sectionId: { type: "string" },
          title: { type: "string" },
          startPage: { type: "integer" },
          endPage: { type: "integer" },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

/** Adjudication schema: the model confirms/corrects weak TOC anchors (SPEC §3.1 step 6). */
export const ADJUDICATION_SCHEMA = {
  type: "object",
  required: ["resolved"],
  additionalProperties: false,
  properties: {
    resolved: {
      type: "array",
      items: {
        type: "object",
        required: ["number", "startPage", "confidence"],
        additionalProperties: false,
        properties: {
          number: { type: "integer" },
          startPage: { type: "integer" },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * Vision schema for the per-page vision step (SPEC §5.3). Coordinates are
 * rendered-image pixels at the configured DPI, top-left origin [x0,y0,x1,y1].
 */
export const VISION_SCHEMA = {
  type: "object",
  required: ["figures", "equations"],
  additionalProperties: false,
  properties: {
    figures: {
      type: "array",
      items: {
        type: "object",
        required: ["bbox"],
        additionalProperties: false,
        properties: {
          bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
          caption: { type: "string" },
          kind: { type: "string", enum: ["diagram", "photo", "graph", "table"] },
        },
      },
    },
    equations: {
      type: "array",
      items: {
        type: "object",
        required: ["latex"],
        additionalProperties: false,
        properties: {
          bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
          latex: { type: "string" },
          display: { type: "boolean" },
        },
      },
    },
  },
} as const;
