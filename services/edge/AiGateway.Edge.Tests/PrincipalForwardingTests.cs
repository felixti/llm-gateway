using System.Security.Claims;
using AiGateway.Edge.Claims;
using Microsoft.AspNetCore.Http;
using Xunit;

public class PrincipalForwardingTests
{
    private static HttpContext CtxWith(ClaimsPrincipal user, params (string, string)[] inboundHeaders)
    {
        var ctx = new DefaultHttpContext { User = user };
        foreach (var (k, v) in inboundHeaders) ctx.Request.Headers[k] = v;
        return ctx;
    }

    [Fact]
    public void Strips_inbound_principal_headers_and_sets_from_claims_for_sp()
    {
        var user = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("appid", "app1"),
            new Claim("idtyp", "app"),
            new Claim("roles", "proj1"),
        }, "test"));

        var ctx = CtxWith(user, ("X-Principal-Id", "SPOOFED"), ("x-principal-kind", "user"));
        var headers = PrincipalForwarder.BuildForwardHeaders(ctx);

        Assert.Equal("app1", headers["X-Principal-Id"]);
        Assert.Equal("sp", headers["X-Principal-Kind"]);
        Assert.Equal("proj1", headers["X-Principal-Project"]);
        // inbound spoof must not survive
        Assert.NotEqual("SPOOFED", headers["X-Principal-Id"]);
    }

    [Fact]
    public void Sets_user_kind_and_no_project_for_delegated_token()
    {
        var user = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("oid", "oid9"),
            new Claim("idtyp", "user"),
        }, "test"));

        var headers = PrincipalForwarder.BuildForwardHeaders(CtxWith(user));

        Assert.Equal("oid9", headers["X-Principal-Id"]);
        Assert.Equal("user", headers["X-Principal-Kind"]);
        Assert.False(headers.ContainsKey("X-Principal-Project"));
    }
}
