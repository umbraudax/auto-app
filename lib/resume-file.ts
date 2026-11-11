import { strFromU8, unzipSync } from "fflate";

export const maxResumeBytes = 8_000_000;
export const docxMimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const manifestPath = "[Content_Types].xml";
const wordDocumentPart = `${docxMimeType}.main+xml`;

export function resumeMimeType(filename: string, bytes: Buffer) {
  if (bytes.length > maxResumeBytes) return;
  if (/\.pdf$/i.test(filename) && bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (!/\.docx$/i.test(filename)) return;

  try {
    const parts = new Set<string>();
    let manifestCount = 0;
    // Inspect the Word package metadata without extracting its contents to disk.
    const manifest = unzipSync(bytes, {
      filter({ name, size, originalSize }) {
        if (originalSize > 0) parts.add(name);
        return name === manifestPath && ++manifestCount === 1 && size <= 65_536 && originalSize <= 65_536;
      },
    })[manifestPath];
    if (!manifest || manifestCount !== 1 || !parts.has("_rels/.rels")) return;

    for (const [tag] of strFromU8(manifest).matchAll(/<(?:[\w.-]+:)?Override\s+[^>]*>/g)) {
      const type = tag.match(/\sContentType\s*=\s*(['"])([^'"]+)\1/)?.[2];
      const part = tag.match(/\sPartName\s*=\s*(['"])\/([^'"]+)\1/)?.[2];
      if (type === wordDocumentPart && part && parts.has(part)) return docxMimeType;
    }
  } catch {
    return undefined;
  }
}
