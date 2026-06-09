using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Yarp.ReverseProxy.Transforms;
using Yarp.ReverseProxy.Transforms.Builder;

namespace AiGateway.Edge.Claims;

public static class PrincipalForwarder
{
    private static readonly string[] PrincipalHeaders =
        { "X-Principal-Id", "X-Principal-Kind", "X-Principal-Project", "X-Principal-Scopes" };

    /// <summary>Strip any inbound X-Principal-* and build the trusted set from validated claims.</summary>
    public static Dictionary<string, string> BuildForwardHeaders(HttpContext ctx)
    {
        var u = ctx.User;
        var headers = new Dictionary<string, string>();

        var isApp = u.FindFirst("idtyp")?.Value == "app" || u.FindFirst("appid") is not null;
        var id = isApp
            ? u.FindFirst("appid")?.Value
            : (u.FindFirst("oid")?.Value ?? u.FindFirst(ClaimTypes.NameIdentifier)?.Value);

        headers["X-Principal-Id"] = id ?? "";
        headers["X-Principal-Kind"] = isApp ? "sp" : "user";

        if (isApp)
        {
            var project = u.FindFirst("roles")?.Value;   // M0: project carried via app role
            if (!string.IsNullOrEmpty(project)) headers["X-Principal-Project"] = project;
        }

        var scopes = u.FindFirst("scp")?.Value;
        if (!string.IsNullOrEmpty(scopes)) headers["X-Principal-Scopes"] = scopes;

        return headers;
    }

    /// <summary>YARP request transform: strip inbound, set trusted, attach M2M token.</summary>
    public static void Apply(TransformBuilderContext builder, IDownstreamTokenProvider tokens, string m2mScope)
    {
        builder.AddRequestTransform(async transform =>
        {
            foreach (var h in PrincipalHeaders) transform.ProxyRequest.Headers.Remove(h);

            foreach (var kv in BuildForwardHeaders(transform.HttpContext))
                transform.ProxyRequest.Headers.TryAddWithoutValidation(kv.Key, kv.Value);

            var token = await tokens.GetM2mTokenAsync(m2mScope, transform.HttpContext.RequestAborted);
            transform.ProxyRequest.Headers.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        });
    }
}
