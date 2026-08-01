export function extractSenderEmail(sender: string): string | null {
  const angleAddress = sender.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/i)?.[1];
  const bareAddress = sender.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/i)?.[0];
  const value = (angleAddress || bareAddress || "").trim().toLowerCase();
  return value && value.length <= 320 ? value : null;
}

export function senderDomain(sender: string): string | null {
  const email = extractSenderEmail(sender);
  if (!email) return null;
  const domain = email.split("@")[1]?.trim();
  return domain || null;
}
