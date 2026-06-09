using AiGateway.Edge.Claims;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Identity.Web;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

builder.Configuration.AddJsonFile("appsettings.Compose.json", optional: true, reloadOnChange: false);

var authMode = builder.Configuration["Auth:Mode"] ?? "entra";
var m2mScope = builder.Configuration["Downstream:M2mScope"] ?? "api://llm-gateway-internal/.default";

if (authMode == "compose-dev")
{
    var authority = builder.Configuration["Auth:Authority"] ?? "http://dev-idp:4000";
    var audience = builder.Configuration["Auth:Audience"] ?? "api://ai-gateway-edge";

    builder.Services
        .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
        .AddJwtBearer(options =>
        {
            options.MapInboundClaims = false;
            options.Authority = authority;
            options.Audience = audience;
            options.RequireHttpsMetadata = false;
            options.MetadataAddress = $"{authority.TrimEnd('/')}/.well-known/openid-configuration";
            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuer = true,
                ValidIssuer = authority,
                ValidateAudience = true,
                ValidAudience = audience,
                ValidateLifetime = true,
                ClockSkew = TimeSpan.FromMinutes(2),
            };
        });

    builder.Services.AddHttpClient<IDownstreamTokenProvider, DevIdpTokenProvider>();
}
else
{
    builder.Services
        .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
        .AddMicrosoftIdentityWebApi(builder.Configuration.GetSection("AzureAd"));

    builder.Services.AddSingleton<IDownstreamTokenProvider, ClientCredentialsTokenProvider>();
}

builder.Services.AddAuthorization();

builder.Services.AddReverseProxy()
    .LoadFromConfig(builder.Configuration.GetSection("ReverseProxy"))
    .AddTransforms(ctx =>
    {
        var tokens = ctx.Services.GetRequiredService<IDownstreamTokenProvider>();
        PrincipalForwarder.Apply(ctx, tokens, m2mScope);
    });

var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

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
