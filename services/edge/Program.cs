using AiGateway.Edge.Claims;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Identity.Web;

var builder = WebApplication.CreateBuilder(args);

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddMicrosoftIdentityWebApi(builder.Configuration.GetSection("AzureAd")); // validates aud=api://ai-gateway-edge

builder.Services.AddAuthorization();
builder.Services.AddSingleton<IDownstreamTokenProvider, ClientCredentialsTokenProvider>();

var m2mScope = builder.Configuration["Downstream:M2mScope"] ?? "api://llm-gateway-internal/.default";

builder.Services.AddReverseProxy()
    .LoadFromConfig(builder.Configuration.GetSection("ReverseProxy"))
    .AddTransforms(ctx =>
    {
        var tokens = ctx.Services.GetRequiredService<IDownstreamTokenProvider>();
        PrincipalForwarder.Apply(ctx, tokens, m2mScope);
    });

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();
app.MapReverseProxy();
app.Run();

/// <summary>M0 placeholder; M-later wires real MSAL client-credentials / workload identity.</summary>
internal sealed class ClientCredentialsTokenProvider : IDownstreamTokenProvider
{
    public Task<string> GetM2mTokenAsync(string scope, CancellationToken ct = default)
        => throw new NotImplementedException("wire MSAL client-credentials in M-later");
}
