FROM mcr.microsoft.com/dotnet/sdk:9.0-alpine AS build
WORKDIR /src
COPY services/edge/AiGateway.Edge.csproj ./
RUN dotnet restore
COPY services/edge/Program.cs services/edge/appsettings.json services/edge/appsettings.Compose.json ./
COPY services/edge/Claims/ ./Claims/
RUN dotnet publish AiGateway.Edge.csproj -c Release -o /app /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:9.0-alpine AS production
WORKDIR /app
RUN apk add --no-cache wget
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
COPY --from=build /app ./
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1
ENTRYPOINT ["dotnet", "AiGateway.Edge.dll"]
