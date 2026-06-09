using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace AiGateway.Edge.Claims;

/// <summary>Mints YARP M2M tokens via the compose dev-idp service.</summary>
internal sealed class DevIdpTokenProvider : IDownstreamTokenProvider
{
    private readonly HttpClient _http;
    private readonly string _devIdpUrl;
    private readonly string _m2mAudience;
    private readonly string _yarpAppId;

    public DevIdpTokenProvider(HttpClient http, IConfiguration configuration)
    {
        _http = http;
        _devIdpUrl = configuration["Downstream:DevIdpUrl"] ?? "http://dev-idp:4000";
        _m2mAudience = configuration["Downstream:M2mAudience"] ?? "api://llm-gateway-internal";
        _yarpAppId = configuration["Downstream:YarpAppId"] ?? "yarp-compose-dev";
    }

    public async Task<string> GetM2mTokenAsync(string scope, CancellationToken ct = default)
    {
        var response = await _http.PostAsJsonAsync(
            $"{_devIdpUrl.TrimEnd('/')}/token",
            new TokenRequest(_m2mAudience, new Dictionary<string, object> { ["appid"] = _yarpAppId }),
            ct);

        response.EnsureSuccessStatusCode();
        var payload = await response.Content.ReadFromJsonAsync<TokenResponse>(cancellationToken: ct)
            ?? throw new InvalidOperationException("dev-idp returned empty token response");
        return payload.AccessToken;
    }

    private sealed record TokenRequest(
        [property: JsonPropertyName("audience")] string Audience,
        [property: JsonPropertyName("claims")] Dictionary<string, object> Claims);

    private sealed record TokenResponse(
        [property: JsonPropertyName("access_token")] string AccessToken);
}
