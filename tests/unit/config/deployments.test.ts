import { describe, it, expect, beforeEach } from "bun:test";
import {
  getDeploymentByAlias,
  getModelFamily,
  getProtocolFamily,
  getDeploymentsByFamily,
  getAllDeployments,
  getFallbackChain,
  getAllModelAliases,
  DEPLOYMENTS,
} from "../../../src/config/deployments";

describe("Deployment Registry", () => {
  describe("getDeploymentByAlias", () => {
    it("should resolve gpt-5.4 alias correctly", () => {
      const deployment = getDeploymentByAlias("gpt-5.4");
      expect(deployment).toBeDefined();
      expect(deployment?.name).toBe("gpt-5.4-global");
      expect(deployment?.modelFamily).toBe("gpt");
      expect(deployment?.protocolFamily).toBe("chat-completions");
    });

    it("should resolve gpt-5-mini alias correctly", () => {
      const deployment = getDeploymentByAlias("gpt-5-mini");
      expect(deployment).toBeDefined();
      expect(deployment?.name).toBe("gpt-5-mini");
      expect(deployment?.modelFamily).toBe("gpt");
      expect(deployment?.protocolFamily).toBe("chat-completions");
    });

    it("should resolve gpt-5.3-codex alias correctly", () => {
      const deployment = getDeploymentByAlias("gpt-5.3-codex");
      expect(deployment).toBeDefined();
      expect(deployment?.modelFamily).toBe("gpt");
    });

    it("should resolve claude-opus-4-6 alias correctly", () => {
      const deployment = getDeploymentByAlias("claude-opus-4-6");
      expect(deployment).toBeDefined();
      expect(deployment?.modelFamily).toBe("claude");
      expect(deployment?.protocolFamily).toBe("anthropic-messages");
    });

    it("should resolve claude-sonnet-4-6 alias correctly", () => {
      const deployment = getDeploymentByAlias("claude-sonnet-4-6");
      expect(deployment).toBeDefined();
      expect(deployment?.modelFamily).toBe("claude");
    });

    it("should resolve claude-haiku-4-5 alias correctly", () => {
      const deployment = getDeploymentByAlias("claude-haiku-4-5");
      expect(deployment).toBeDefined();
      expect(deployment?.modelFamily).toBe("claude");
    });

    it("should resolve kimi-k2.5 alias correctly", () => {
      const deployment = getDeploymentByAlias("kimi-k2.5");
      expect(deployment).toBeDefined();
      expect(deployment?.modelFamily).toBe("kimi");
      expect(deployment?.protocolFamily).toBe("chat-completions");
    });

    it("should resolve glm-5 alias correctly", () => {
      const deployment = getDeploymentByAlias("glm-5");
      expect(deployment).toBeDefined();
      expect(deployment?.modelFamily).toBe("glm");
    });

    it("should resolve minimax-m2.5 alias correctly", () => {
      const deployment = getDeploymentByAlias("minimax-m2.5");
      expect(deployment).toBeDefined();
      expect(deployment?.modelFamily).toBe("minimax");
    });

    it("should be case-insensitive", () => {
      expect(getDeploymentByAlias("GPT-5.4")?.name).toBe("gpt-5.4-global");
      expect(getDeploymentByAlias("GPT-5-MINI")?.name).toBe("gpt-5-mini");
      expect(getDeploymentByAlias("Claude-Opus-4-6")?.name).toBe("claude-opus-4-6");
      expect(getDeploymentByAlias("KIMI-K2.5")?.name).toBe("kimi-k2.5");
    });

    it("should return undefined for unknown alias", () => {
      expect(getDeploymentByAlias("unknown-model")).toBeUndefined();
    });
  });

  describe("getModelFamily", () => {
    it("should return correct model family for all aliases", () => {
      expect(getModelFamily("gpt-5-mini")).toBe("gpt");
      expect(getModelFamily("gpt-5.4")).toBe("gpt");
      expect(getModelFamily("gpt-5.3-codex")).toBe("gpt");
      expect(getModelFamily("claude-opus-4-6")).toBe("claude");
      expect(getModelFamily("claude-sonnet-4-6")).toBe("claude");
      expect(getModelFamily("claude-haiku-4-5")).toBe("claude");
      expect(getModelFamily("kimi-k2.5")).toBe("kimi");
      expect(getModelFamily("glm-5")).toBe("glm");
      expect(getModelFamily("minimax-m2.5")).toBe("minimax");
    });

    it("should return undefined for unknown alias", () => {
      expect(getModelFamily("unknown")).toBeUndefined();
    });
  });

  describe("getProtocolFamily", () => {
    it("should return chat-completions for GPT models", () => {
      expect(getProtocolFamily("gpt-5-mini")).toBe("chat-completions");
      expect(getProtocolFamily("gpt-5.4")).toBe("chat-completions");
      expect(getProtocolFamily("gpt-5.3-codex")).toBe("chat-completions");
    });

    it("should return anthropic-messages for Claude models", () => {
      expect(getProtocolFamily("claude-opus-4-6")).toBe("anthropic-messages");
      expect(getProtocolFamily("claude-sonnet-4-6")).toBe("anthropic-messages");
      expect(getProtocolFamily("claude-haiku-4-5")).toBe("anthropic-messages");
    });

    it("should return chat-completions for third-party models", () => {
      expect(getProtocolFamily("kimi-k2.5")).toBe("chat-completions");
      expect(getProtocolFamily("glm-5")).toBe("chat-completions");
      expect(getProtocolFamily("minimax-m2.5")).toBe("chat-completions");
    });
  });

  describe("getDeploymentsByFamily", () => {
    it("should return all GPT deployments", () => {
      const gptDeployments = getDeploymentsByFamily("gpt");
      expect(gptDeployments.length).toBe(3);
      expect(gptDeployments.map(d => d.modelAlias)).toContain("gpt-5-mini");
      expect(gptDeployments.map(d => d.modelAlias)).toContain("gpt-5.4");
      expect(gptDeployments.map(d => d.modelAlias)).toContain("gpt-5.3-codex");
    });

    it("should return all Claude deployments", () => {
      const claudeDeployments = getDeploymentsByFamily("claude");
      expect(claudeDeployments.length).toBe(3);
      expect(claudeDeployments.map(d => d.modelAlias)).toContain("claude-opus-4-6");
      expect(claudeDeployments.map(d => d.modelAlias)).toContain("claude-sonnet-4-6");
      expect(claudeDeployments.map(d => d.modelAlias)).toContain("claude-haiku-4-5");
    });

    it("should return all Kimi deployments", () => {
      const kimiDeployments = getDeploymentsByFamily("kimi");
      expect(kimiDeployments.length).toBe(1);
      expect(kimiDeployments[0].modelAlias).toBe("kimi-k2.5");
    });

    it("should return all GLM deployments", () => {
      const glmDeployments = getDeploymentsByFamily("glm");
      expect(glmDeployments.length).toBe(1);
      expect(glmDeployments[0].modelAlias).toBe("glm-5");
    });

    it("should return all MiniMax deployments", () => {
      const minimaxDeployments = getDeploymentsByFamily("minimax");
      expect(minimaxDeployments.length).toBe(1);
      expect(minimaxDeployments[0].modelAlias).toBe("minimax-m2.5");
    });
  });

  describe("getAllDeployments", () => {
    it("should return all 8 enabled deployments", () => {
      const all = getAllDeployments();
      expect(all.length).toBe(9);
    });
  });

  describe("getFallbackChain", () => {
    it("should return fallback chain for GPT-5.4", () => {
      const deployment = getDeploymentByAlias("gpt-5.4")!;
      const chain = getFallbackChain(deployment);
      expect(chain.length).toBe(1);
      expect(chain[0].modelAlias).toBe("gpt-5.3-codex");
    });

    it("should return fallback chain for GPT-5 Mini", () => {
      const deployment = getDeploymentByAlias("gpt-5-mini")!;
      const chain = getFallbackChain(deployment);
      expect(chain.length).toBe(1);
      expect(chain[0].modelAlias).toBe("gpt-5.3-codex");
    });

    it("should return fallback chain for Claude Opus", () => {
      const deployment = getDeploymentByAlias("claude-opus-4-6")!;
      const chain = getFallbackChain(deployment);
      expect(chain.length).toBe(2);
      expect(chain[0].modelAlias).toBe("claude-sonnet-4-6");
      expect(chain[1].modelAlias).toBe("claude-haiku-4-5");
    });

    it("should return empty chain for Claude Haiku (no fallback)", () => {
      const deployment = getDeploymentByAlias("claude-haiku-4-5")!;
      const chain = getFallbackChain(deployment);
      expect(chain.length).toBe(0);
    });

    it("should return empty chain for Kimi (no fallback configured)", () => {
      const deployment = getDeploymentByAlias("kimi-k2.5")!;
      const chain = getFallbackChain(deployment);
      expect(chain.length).toBe(0);
    });

    it("does not infinite loop when fallback chain forms a cycle", () => {
      const deploymentA: import("@/config/deployments").DeploymentConfig = {
        name: "cycle-a",
        modelAlias: "cycle-a",
        modelFamily: "gpt",
        protocolFamily: "chat-completions",
        azureModelName: "cycle-a",
        endpoint: "https://example.com",
        authConfig: { type: "api-key", apiKey: "k", keyHeader: "api-key" },
        apiVersion: "2024-06-01",
        fallbackDeployment: "claude-opus-4-6",
        enabled: true,
      };

      const chain = getFallbackChain(deploymentA);
      expect(Array.isArray(chain)).toBe(true);
      const names = chain.map((d) => d.name);
      expect(names).not.toContain(deploymentA.name);
    });
  });

  describe("getAllModelAliases", () => {
    it("should return all 8 model aliases", () => {
      const aliases = getAllModelAliases();
      expect(aliases.length).toBe(9);
      expect(aliases).toContain("gpt-5-mini");
      expect(aliases).toContain("gpt-5.4");
      expect(aliases).toContain("gpt-5.3-codex");
      expect(aliases).toContain("claude-opus-4-6");
      expect(aliases).toContain("claude-sonnet-4-6");
      expect(aliases).toContain("claude-haiku-4-5");
      expect(aliases).toContain("kimi-k2.5");
      expect(aliases).toContain("glm-5");
      expect(aliases).toContain("minimax-m2.5");
    });
  });

  describe("Deployment Configuration", () => {
    it("should have correct endpoints for each model family", () => {
      // GPT models should use Azure OpenAI endpoint
      const gptDeployment = getDeploymentByAlias("gpt-5-mini");
      expect(gptDeployment?.endpoint).toMatch(/^https:\/\//);

      // Claude models should use Azure AI Foundry endpoint
      const claudeDeployment = getDeploymentByAlias("claude-opus-4-6");
      expect(claudeDeployment?.endpoint).toMatch(/^https:\/\//);

      // Kimi should use Azure AI Foundry endpoint
      const kimiDeployment = getDeploymentByAlias("kimi-k2.5");
      expect(kimiDeployment?.endpoint).toMatch(/^https:\/\//);
    });

    it("should have correct API versions", () => {
      // GPT and Kimi/GLM/MiniMax should use chat completions API version
      expect(getDeploymentByAlias("gpt-5-mini")?.apiVersion).toBe("2024-06-01");
      expect(getDeploymentByAlias("gpt-5.4")?.apiVersion).toBe("2024-06-01");
      expect(getDeploymentByAlias("kimi-k2.5")?.apiVersion).toBe("2024-06-01");

      // Claude should use Anthropic API version
      expect(getDeploymentByAlias("claude-opus-4-6")?.apiVersion).toBe("2023-06-01");
    });

    it("should have correct auth config types", () => {
      // All deployments should have an auth config
      for (const deployment of DEPLOYMENTS) {
        expect(deployment.authConfig).toBeDefined();
        expect(["entra-id", "api-key"]).toContain(deployment.authConfig.type);
      }
    });

    it("should use OpenAI-compatible api-key header for Foundry chat models", () => {
      expect(getDeploymentByAlias("kimi-k2.5")?.authConfig.keyHeader).toBe("api-key");
      expect(getDeploymentByAlias("glm-5")?.authConfig.keyHeader).toBe("api-key");
      expect(getDeploymentByAlias("minimax-m2.5")?.authConfig.keyHeader).toBe("api-key");
    });
  });
});
