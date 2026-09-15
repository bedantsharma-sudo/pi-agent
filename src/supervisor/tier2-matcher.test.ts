import { describe, expect, it } from "vitest";
import { needsTier2Judgment } from "./tier2-matcher.js";

describe("needsTier2Judgment", () => {
  it("flags writes to a migrations directory", () => {
    expect(needsTier2Judgment("write", { path: "/workspace/fastrr-oms/src/main/resources/migrations/V2.sql" })).toBe(true);
  });

  it("flags writes to scheduler-service", () => {
    expect(needsTier2Judgment("edit", { path: "/workspace/scheduler-service/src/Job.java" })).toBe(true);
  });

  it("flags writes to production/staging properties files", () => {
    expect(needsTier2Judgment("write", { path: "/workspace/aggregator-service/application-prod.properties" })).toBe(true);
  });

  it("flags cron/quartz-related paths", () => {
    expect(needsTier2Judgment("edit", { path: "/workspace/fastrr-oms/src/main/java/CronController.java" })).toBe(true);
  });

  it("does not flag an ordinary service file", () => {
    expect(needsTier2Judgment("edit", { path: "/workspace/aggregator-service/src/main/java/Foo.java" })).toBe(false);
  });

  it("does not flag non-write/edit tools", () => {
    expect(needsTier2Judgment("bash", { command: "mvn test" })).toBe(false);
  });
});
