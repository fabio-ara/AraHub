import assert from "node:assert/strict";
import { moodleMobileLaunchUrl, parseMoodleMobileLink } from "../web/moodle_mobile.ts";

Deno.test("mobile launch opens the official site path with a one-use passport", () => {
  const url = new URL(moodleMobileLaunchUrl(
    "https://elearning.example.edu/moodle",
    "0123456789abcdef0123456789abcdef",
  ));
  assert.equal(url.origin, "https://elearning.example.edu");
  assert.equal(url.pathname, "/moodle/admin/tool/mobile/launch.php");
  assert.equal(url.searchParams.get("service"), "moodle_mobile_app");
  assert.equal(url.searchParams.get("passport"), "0123456789abcdef0123456789abcdef");
  assert.equal(url.searchParams.get("confirmed"), "1");
  assert.throws(() =>
    moodleMobileLaunchUrl("http://moodle.example.edu", "0123456789abcdef0123456789abcdef")
  );
});

Deno.test("mobile link extracts only the Web Service token", () => {
  const token = "a".repeat(32);
  const privateToken = "b".repeat(32);
  const payload = btoa(`${"c".repeat(32)}:::${token}:::${privateToken}`);
  assert.equal(parseMoodleMobileLink(`moodlemobile://token=${payload}`), token);
  assert.throws(() => parseMoodleMobileLink(`moodlemobile://token=${btoa("invalid")}`));
  assert.throws(() => parseMoodleMobileLink("https://example.edu/?token=fake"));
});
