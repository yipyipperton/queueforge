import { describe, expect, it } from "vitest";
import { ipBucket } from "@/lib/core/ip";

describe("rate-limit ip bucketing", () => {
  it("groups IPv4 by /24 and takes the first forwarded hop", () => {
    expect(ipBucket("140.248.52.81")).toBe("140.248.52.0/24");
    expect(ipBucket("140.248.52.7, 10.0.0.1")).toBe("140.248.52.0/24");
    expect(ipBucket("::ffff:1.2.3.4")).toBe("1.2.3.0/24");
  });
  it("groups IPv6 by /64", () => {
    expect(ipBucket("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("[2001:0db8:0001:0002:0:0:0:9]")).toBe("2001:db8:1:2::/64");
  });
  it("handles missing values", () => { expect(ipBucket(null)).toBe("unknown"); expect(ipBucket("")).toBe("unknown"); });
});
