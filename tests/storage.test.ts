import { describe, expect, test } from "vitest";
import { contentTypeForKey, extensionForUpload } from "@/lib/storage";

/**
 * Extension <-> MIME mapping.
 *
 * This exists because of a bug it would have caught immediately.
 * `contentTypeForKey` compared a dotless extension (`"mp4"`) against a table of
 * dotted ones (`[".mp4"]`) using `Array.prototype.includes`, which is exact
 * match. Nothing ever matched, so every stored object was served as
 * `application/octet-stream`.
 *
 * That failure is invisible in a unit test of anything else, and close to
 * invisible in the app: `nosniff` is set (correctly), so the browser refuses to
 * render a stored image at all and downloads a stored video rather than playing
 * it. Nothing throws, no page 500s, and the gallery still returns 200. It simply
 * shows nothing.
 *
 * So the tests below assert the mapping directly, in both directions, and include
 * the case that no caller would think to check: that every entry in the table is
 * reachable.
 */

describe("contentTypeForKey", () => {
  test("maps a stored video extension to its real type", () => {
    expect(contentTypeForKey("video/8f2c1e40-1111-4111-8111-aaaaaaaaaaaa.mp4")).toBe(
      "video/mp4",
    );
  });

  test("maps every image extension the app stores", () => {
    expect(contentTypeForKey("image/8f2c1e40-1111-4111-8111-aaaaaaaaaaaa.png")).toBe("image/png");
    expect(contentTypeForKey("image/8f2c1e40-1111-4111-8111-aaaaaaaaaaaa.jpg")).toBe("image/jpeg");
    expect(contentTypeForKey("image/8f2c1e40-1111-4111-8111-aaaaaaaaaaaa.jpeg")).toBe("image/jpeg");
    expect(contentTypeForKey("image/8f2c1e40-1111-4111-8111-aaaaaaaaaaaa.webp")).toBe("image/webp");
  });

  test("the case does not matter, because keys are written lowercase", () => {
    // Defence in depth: a key built by hand or by an older version should not
    // fall through to octet-stream purely on capitalisation.
    expect(contentTypeForKey("video/AAAA.MP4")).toBe("video/mp4");
  });

  test("an unknown extension stays octet-stream rather than being guessed", () => {
    // The safe default, and the reason the fallback exists: rendering unknown
    // bytes as a guessed type is how a stored-XSS bug happens.
    expect(contentTypeForKey("upload/whatever.html")).toBe("application/octet-stream");
    expect(contentTypeForKey("upload/whatever.svg")).toBe("application/octet-stream");
    expect(contentTypeForKey("upload/whatever.exe")).toBe("application/octet-stream");
  });

  test("a key with no extension is octet-stream", () => {
    expect(contentTypeForKey("video/8f2c1e40-1111-4111-8111-aaaaaaaaaaaa")).toBe(
      "application/octet-stream",
    );
  });

  test("an extension that is only a suffix of a stored one does not match", () => {
    // `.g` is a substring of nothing stored, but `.p` and `.pe` would be suffixes
    // of `.png`. Substring matching here would serve arbitrary bytes as an image.
    expect(contentTypeForKey("upload/file.p")).toBe("application/octet-stream");
    expect(contentTypeForKey("upload/file.pe")).toBe("application/octet-stream");
    expect(contentTypeForKey("upload/file.pngx")).toBe("application/octet-stream");
  });
});

describe("extensionForUpload", () => {
  test("the validated content type decides the extension, not the filename", () => {
    // This is the stored-XSS guard: an `.html` name uploaded as a video must not
    // come back as `.html`, because the served content type follows the
    // extension.
    expect(extensionForUpload("payload.html", "video/mp4")).toBe(".mp4");
    expect(extensionForUpload("payload.svg", "image/png")).toBe(".png");
    expect(extensionForUpload("C:\\Users\\me\\photo.png.exe", "image/jpeg")).toBe(".jpg");
  });

  test("a rejected type gets a sanitised extension or none at all", () => {
    expect(extensionForUpload("notes.txt", "text/plain")).toBe(".txt");
    // Not `[a-z0-9]{1,8}`, so dropped rather than passed through.
    expect(extensionForUpload("weird.verylongextension", "text/plain")).toBe("");
    expect(extensionForUpload("noextension", "text/plain")).toBe("");
  });

  test("round-trips with contentTypeForKey", () => {
    // The two functions have to agree, or an object is written under one type and
    // served as another. They share the table precisely so they cannot drift, and
    // this asserts it for the types the app actually stores.
    for (const type of ["video/mp4", "image/png", "image/jpeg", "image/webp"]) {
      const ext = extensionForUpload("upload", type);
      expect(contentTypeForKey(`video/abc${ext}`)).toBe(type);
    }
  });
});