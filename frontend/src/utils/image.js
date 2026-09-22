// Downscales/compresses a picked image file client-side (raw phone-camera
// photos can be several MB) so the resulting base64 payload stays small
// enough to store and send comfortably, regardless of the source image's
// original resolution.
export function compressImageFile(file, maxDim = 900, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file"));
    reader.onload = () => {
      img.onerror = () => reject(new Error("Could not read the selected image"));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Reads any file (PDF, doc, etc.) as a base64 data URL as-is — no compression
// possible for non-image types, so a client-side size cap stands in for it.
export function readFileAsDataUrl(file, maxBytes = 5_000_000) {
  return new Promise((resolve, reject) => {
    if (file.size > maxBytes) {
      reject(new Error(`File is too large (max ${Math.round(maxBytes / 1_000_000)}MB)`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}
