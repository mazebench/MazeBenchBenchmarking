// Display labels are independent of the provider IDs stored in run records.
export function modelLabel(model, fallback = model) {
  if (model === "k3.1-pro") return "Kimi K3.1 Pro";
  if (model === "k3.1-pro-highspeed") return "Kimi K3.1 Pro Highspeed";
  return model === "gemini-4-argon-high" ? "Gemini 4 Argon" : fallback;
}
