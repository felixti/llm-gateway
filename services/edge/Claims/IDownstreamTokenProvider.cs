namespace AiGateway.Edge.Claims;

/// <summary>Acquires YARP's own per-hop M2M token (aud = api://llm-gateway-internal).</summary>
public interface IDownstreamTokenProvider
{
    Task<string> GetM2mTokenAsync(string scope, CancellationToken ct = default);
}
