/**
 * Normalise a client IP into a rate-limit bucket: IPv4 -> /24, IPv6 -> /64.
 * Rotating addresses within one network (proxy pools, IPv6 privacy addresses) share one bucket.
 */
export function ipBucket(raw: string | null | undefined): string {
  const ip = (raw ?? "").split(",")[0].trim().replace(/^\[|\]$/g, "");
  if (!ip) return "unknown";
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(":")) {
    const [head, tail = ""] = ip.toLowerCase().split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
    return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "") || "0").join(":")}::/64`;
  }
  return ip.slice(0, 64);
}
