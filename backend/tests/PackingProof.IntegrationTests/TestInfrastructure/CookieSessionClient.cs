using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using PackingProof.Api.Features.Auth;

namespace PackingProof.IntegrationTests.TestInfrastructure;

public sealed class CookieSessionClient : IDisposable
{
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter() }
    };

    public HttpClient Http { get; }
    public string? CsrfToken { get; private set; }

    public CookieSessionClient(HttpClient httpClient)
    {
        Http = httpClient;
    }

    public async Task<string> RefreshCsrfAsync()
    {
        var res = await Http.GetAsync("/api/auth/csrf");
        res.EnsureSuccessStatusCode();
        var payload = await res.Content.ReadFromJsonAsync<CsrfTokenResponse>(JsonOptions);
        CsrfToken = payload?.Token ?? string.Empty;
        return CsrfToken;
    }

    public async Task<LoginResponse> LoginAsync(string email, string password)
    {
        await EnsureCsrfTokenAsync();
        var response = await PostJsonAsync("/api/auth/login", new LoginRequest(email, password));
        response.EnsureSuccessStatusCode();
        var loginPayload = (await response.Content.ReadFromJsonAsync<LoginResponse>(JsonOptions))!;
        if (!string.IsNullOrEmpty(loginPayload.CsrfToken))
        {
            CsrfToken = loginPayload.CsrfToken;
        }
        else if (!loginPayload.RequiresTwoFactor)
        {
            await RefreshCsrfAsync();
        }

        return loginPayload;
    }

    public Task<HttpResponseMessage> GetAsync(string url) => Http.GetAsync(url);

    public async Task<HttpResponseMessage> PostJsonAsync<T>(
        string url,
        T body,
        bool includeCsrf = true)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = JsonContent.Create(body, options: JsonOptions)
        };

        if (includeCsrf)
        {
            await AttachCsrfAsync(req);
        }

        return await Http.SendAsync(req);
    }

    public async Task<HttpResponseMessage> PutJsonAsync<T>(
        string url,
        T body,
        bool includeCsrf = true)
    {
        using var req = new HttpRequestMessage(HttpMethod.Put, url)
        {
            Content = JsonContent.Create(body, options: JsonOptions)
        };

        if (includeCsrf)
        {
            await AttachCsrfAsync(req);
        }

        return await Http.SendAsync(req);
    }

    private async Task EnsureCsrfTokenAsync()
    {
        if (string.IsNullOrEmpty(CsrfToken))
        {
            await RefreshCsrfAsync();
        }
    }

    private async Task AttachCsrfAsync(HttpRequestMessage request)
    {
        await EnsureCsrfTokenAsync();
        request.Headers.Remove("X-CSRF-Token");
        request.Headers.Add("X-CSRF-Token", CsrfToken);
    }

    public void Dispose() => Http.Dispose();
}

