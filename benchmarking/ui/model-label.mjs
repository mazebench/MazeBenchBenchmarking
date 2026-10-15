// Display labels are independent of the provider IDs stored in run records.
export function modelLabel(model, fallback = model) {
  return model === "gemini-4-argon-high" ? "Gemini 4 Argon" : fallback;
}
