/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { restoreChatApiAttachments } from "./attachment-api.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

describe("buildUserChatMessageContentBlocks", () => {
  it("keeps staged video attachments typed as video content", () => {
    expect(
      buildUserChatMessageContentBlocks("", [
        {
          id: "video-1",
          mimeType: "video/mp4",
          fileName: "demo.mp4",
          previewUrl: "blob:demo-video",
        },
      ]),
    ).toEqual([
      {
        type: "attachment",
        attachment: {
          url: "blob:demo-video",
          kind: "video",
          label: "demo.mp4",
          mimeType: "video/mp4",
        },
      },
    ]);
  });

  it.each([
    ["clip.avi", ""],
    ["clip.mp4", ""],
    ["clip.mkv", ""],
    ["clip.mpeg", ""],
    ["clip.mpg", ""],
    ["clip.mkv", "application/octet-stream"],
  ])("falls back to the %s extension when MIME is %s", (fileName, mimeType) => {
    const [block] = buildUserChatMessageContentBlocks("", [
      {
        id: `video-${fileName}-${mimeType}`,
        mimeType,
        fileName,
        previewUrl: `blob:${fileName}`,
      },
    ]);

    expect(block?.attachment?.kind).toBe("video");
  });

  it("renders persisted startup attachment metadata without payload bytes", () => {
    const attachments = restoreChatApiAttachments([
      { mimeType: "image/png", fileName: "diagram.png", sizeBytes: 42 },
    ]);

    expect(attachments).toEqual([
      expect.objectContaining({ mimeType: "image/png", fileName: "diagram.png", sizeBytes: 42 }),
    ]);
    expect(attachments[0]).not.toHaveProperty("dataUrl");
    expect(buildUserChatMessageContentBlocks("", attachments)).toEqual([
      {
        type: "attachment",
        attachment: {
          url: "",
          kind: "image",
          label: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 42,
        },
      },
    ]);
  });
});
