using System.Net;
using System.Text;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Uploads;
using tusdotnet.Models;
using tusdotnet.Models.Configuration;
using tusdotnet.Models.Expiration;
using tusdotnet.Stores;

namespace PackingProof.Api.Features.Uploads;

public static class TusConfigurationFactory
{
    private const string ValidatedUploadSessionIdItemKey = "PackingProof.ValidatedUploadSessionId";

    public static async Task<DefaultTusConfiguration> CreateAsync(HttpContext httpContext)
    {
        var options = httpContext.RequestServices.GetRequiredService<PackingProofOptions>();
        var stagingFullPath = Path.GetFullPath(options.StagingRootPath);
        Directory.CreateDirectory(stagingFullPath);

        var effectiveMaxUploadBytes = options.MaxUploadBytes;
        if (httpContext.Request.Path.StartsWithSegments("/api/uploads"))
        {
            var db = httpContext.RequestServices.GetRequiredService<PackingProofDbContext>();
            var profile = await db.StorageProfiles
                .AsNoTracking()
                .OrderBy(p => p.Name)
                .FirstOrDefaultAsync(httpContext.RequestAborted);
            if (profile is not null && profile.MaxUploadBytes > 0)
            {
                effectiveMaxUploadBytes = profile.MaxUploadBytes;
            }
        }

        var maxBodyFeature = httpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (maxBodyFeature is { IsReadOnly: false })
        {
            maxBodyFeature.MaxRequestBodySize = effectiveMaxUploadBytes;
        }

        var tusStore = new TusDiskStore(stagingFullPath);

        var config = new DefaultTusConfiguration
        {
            UrlPath = "/api/uploads",
            Store = tusStore,
            MaxAllowedUploadSizeInBytesLong = effectiveMaxUploadBytes,
            MetadataParsingStrategy = MetadataParsingStrategy.AllowEmptyValues,
            AllowedExtensions = new TusExtensions(
                TusExtensions.Creation,
                TusExtensions.CreationWithUpload,
                TusExtensions.Termination,
                TusExtensions.Checksum,
                TusExtensions.Expiration),
            Expiration = new SlidingExpiration(TimeSpan.FromHours(24)),
            Events = new Events
            {
                OnAuthorizeAsync = HandleAuthorizeAsync,
                OnBeforeCreateAsync = HandleBeforeCreateAsync,
                OnCreateCompleteAsync = HandleCreateCompleteAsync,
                OnFileCompleteAsync = HandleFileCompleteAsync,
                OnDeleteCompleteAsync = HandleDeleteCompleteAsync
            }
        };

        return config;
    }

    private static async Task HandleAuthorizeAsync(AuthorizeContext ctx)
    {
        var httpContext = ctx.HttpContext;
        if (httpContext.User.Identity?.IsAuthenticated != true ||
            httpContext.TryGetUserId() is not { } userId)
        {
            ctx.FailRequest(
                HttpStatusCode.Unauthorized,
                "Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.");
            return;
        }

        var scopeAuth = httpContext.RequestServices.GetRequiredService<IScopeAuthorizationService>();

        switch (ctx.Intent)
        {
            case IntentType.ConcatenateFiles:
                ctx.FailRequest(
                    HttpStatusCode.BadRequest,
                    "Hệ thống không hỗ trợ tiện ích ghép tệp tus (Concatenation).");
                return;

            case IntentType.GetOptions:
            case IntentType.CreateFile:
            {
                var hasAnyUploadScope =
                    await scopeAuth.HasAnyScopeForPermissionAsync(
                        userId,
                        PermissionCatalog.VideoUpload,
                        ctx.CancellationToken) ||
                    await scopeAuth.HasAnyScopeForPermissionAsync(
                        userId,
                        PermissionCatalog.VideoImport,
                        ctx.CancellationToken);

                if (!hasAnyUploadScope)
                {
                    ctx.FailRequest(
                        HttpStatusCode.Forbidden,
                        "Tài khoản của bạn không có quyền tải video lên hệ thống.");
                }
                return;
            }

            case IntentType.GetFileInfo:
            case IntentType.WriteFile:
            case IntentType.DeleteFile:
            {
                if (string.IsNullOrWhiteSpace(ctx.FileId) ||
                    ctx.FileId.StartsWith(StagingQuotaGuard.PendingResourcePrefix, StringComparison.Ordinal))
                {
                    ctx.FailRequest(HttpStatusCode.NotFound, "Không tìm thấy tài nguyên tải lên.");
                    return;
                }

                var db = httpContext.RequestServices.GetRequiredService<PackingProofDbContext>();
                var session = await db.UploadSessions
                    .AsNoTracking()
                    .Include(u => u.Recording)
                    .FirstOrDefaultAsync(u =>
                        u.TusResourceId == ctx.FileId &&
                        !u.Recording.IsSoftDeleted,
                        ctx.CancellationToken);

                if (session is null)
                {
                    ctx.FailRequest(HttpStatusCode.NotFound, "Không tìm thấy phiên tải lên tương ứng.");
                    return;
                }

                var isOwner = session.OwnerUserId == userId &&
                              session.Recording.OwnerUserId == userId;

                var resourceScope = new ResourceScopeContext(
                    OwnerUserId: session.Recording.OwnerUserId,
                    ShopId: session.Recording.ShopId,
                    WarehouseId: session.Recording.WarehouseId);

                var hasUploadScope = isOwner &&
                    (await scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoUpload, resourceScope, ctx.CancellationToken) ||
                     (session.Recording.Source == RecordingSource.Imported &&
                      await scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoImport, resourceScope, ctx.CancellationToken)));

                if (!hasUploadScope)
                {
                    ctx.FailRequest(
                        HttpStatusCode.Forbidden,
                        "Bạn không có quyền truy cập hoặc thao tác trên phiên tải lên của người dùng khác.");
                    return;
                }

                if (ctx.Intent == IntentType.WriteFile)
                {
                    if (session.Recording.StorageStatus == StorageStatus.Stored ||
                        session.Recording.CaptureStatus is not (CaptureStatus.Captured or CaptureStatus.Interrupted))
                    {
                        ctx.FailRequest(
                            HttpStatusCode.Conflict,
                            "Phiên quay không ở trạng thái cho phép ghi tiếp dữ liệu tải lên.");
                        return;
                    }
                }
                else if (ctx.Intent == IntentType.DeleteFile)
                {
                    if (session.Recording.StorageStatus is StorageStatus.Stored or StorageStatus.Validating or StorageStatus.WaitingForStorage)
                    {
                        ctx.FailRequest(
                            HttpStatusCode.Conflict,
                            "Tệp đã hoàn tất tải lên và đang/đã lưu trữ, không thể hủy phiên tải lên.");
                        return;
                    }
                }

                return;
            }
        }
    }

    private static async Task HandleBeforeCreateAsync(BeforeCreateContext ctx)
    {
        var httpContext = ctx.HttpContext;
        var userId = httpContext.GetRequiredUserId();

        if (ctx.UploadLengthIsDeferred)
        {
            ctx.FailRequest(
                HttpStatusCode.BadRequest,
                "Yêu cầu khai báo dung lượng tệp cố định (Upload-Length).");
            return;
        }

        var db = httpContext.RequestServices.GetRequiredService<PackingProofDbContext>();
        var options = httpContext.RequestServices.GetRequiredService<PackingProofOptions>();
        var scopeAuth = httpContext.RequestServices.GetRequiredService<IScopeAuthorizationService>();
        var stagingQuotaGuard = httpContext.RequestServices.GetRequiredService<StagingQuotaGuard>();

        var profile = await db.StorageProfiles
            .AsNoTracking()
            .OrderBy(p => p.Name)
            .FirstOrDefaultAsync(ctx.CancellationToken);
        var maxUploadBytes = profile?.MaxUploadBytes ?? options.MaxUploadBytes;

        if (ctx.UploadLength <= 0)
        {
            ctx.FailRequest(HttpStatusCode.BadRequest, "Dung lượng tệp tải lên phải lớn hơn 0 byte.");
            return;
        }

        if (ctx.UploadLength > maxUploadBytes)
        {
            ctx.FailRequest(
                HttpStatusCode.RequestEntityTooLarge,
                "Dung lượng tệp vượt quá giới hạn tối đa cho phép.");
            return;
        }

        // Parse ONLY trusted correlation IDs; ignore all untrusted client metadata (owner, shop, path, filename, etc.)
        if (!TryReadGuidMetadata(ctx.Metadata, "recordingId", out var recordingId) ||
            !TryReadGuidMetadata(ctx.Metadata, "uploadSessionId", out var uploadSessionId))
        {
            ctx.FailRequest(
                HttpStatusCode.BadRequest,
                "Thiếu thông tin định danh recordingId hoặc uploadSessionId hợp lệ trong Upload-Metadata.");
            return;
        }

        var session = await db.UploadSessions
            .AsNoTracking()
            .Include(u => u.Recording)
            .FirstOrDefaultAsync(u =>
                u.Id == uploadSessionId &&
                !u.Recording.IsSoftDeleted,
                ctx.CancellationToken);

        if (session is null || session.RecordingId != recordingId)
        {
            ctx.FailRequest(
                HttpStatusCode.NotFound,
                "Phiên tải lên không tồn tại hoặc không khớp với bản ghi phiên quay.");
            return;
        }

        var isOwner = session.OwnerUserId == userId &&
                      session.Recording.OwnerUserId == userId;

        var beforeCreateScope = new ResourceScopeContext(
            OwnerUserId: session.Recording.OwnerUserId,
            ShopId: session.Recording.ShopId,
            WarehouseId: session.Recording.WarehouseId);

        var hasUploadScope = isOwner &&
            (await scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoUpload, beforeCreateScope, ctx.CancellationToken) ||
             (session.Recording.Source == RecordingSource.Imported &&
              await scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoImport, beforeCreateScope, ctx.CancellationToken)));

        if (!hasUploadScope)
        {
            ctx.FailRequest(
                HttpStatusCode.Forbidden,
                "Bạn không có quyền khởi tạo tệp tải lên cho phiên quay này.");
            return;
        }

        if (session.Recording.StorageStatus == StorageStatus.Stored ||
            session.Recording.CaptureStatus is not (CaptureStatus.Captured or CaptureStatus.Interrupted))
        {
            ctx.FailRequest(
                HttpStatusCode.Conflict,
                "Trạng thái phiên quay hiện tại không hợp lệ để tải dữ liệu video lên.");
            return;
        }

        if (ctx.UploadLength != session.ExpectedBytes)
        {
            ctx.FailRequest(
                HttpStatusCode.BadRequest,
                "Giá trị Upload-Length không khớp với dung lượng đã khai báo trong phiên tải lên.");
            return;
        }

        var (allowed, _) = await stagingQuotaGuard.CanAccommodateAsync(
            session.ExpectedBytes,
            excludeRecordingId: recordingId,
            ct: ctx.CancellationToken);

        if (!allowed)
        {
            ctx.FailRequest(
                HttpStatusCode.InsufficientStorage,
                "Vùng lưu đệm tải lên trên máy chủ hiện đã đầy. Vui lòng thử lại sau.");
            return;
        }

        httpContext.Items[ValidatedUploadSessionIdItemKey] = session.Id;
    }

    private static async Task HandleCreateCompleteAsync(CreateCompleteContext ctx)
    {
        if (!ctx.HttpContext.Items.TryGetValue(ValidatedUploadSessionIdItemKey, out var rawId) ||
            rawId is not Guid uploadSessionId)
        {
            return;
        }

        var coordinator = ctx.HttpContext.RequestServices.GetRequiredService<RecordingUploadCoordinator>();
        await coordinator.BindTusFileCreatedAsync(uploadSessionId, ctx.FileId, ctx.CancellationToken);
    }

    private static async Task HandleFileCompleteAsync(FileCompleteContext ctx)
    {
        var receivedBytes = await ctx.Store.GetUploadOffsetAsync(ctx.FileId, ctx.CancellationToken);
        var coordinator = ctx.HttpContext.RequestServices.GetRequiredService<RecordingUploadCoordinator>();
        await coordinator.HandleTusFileCompletedAsync(ctx.FileId, receivedBytes, ctx.CancellationToken);
    }

    private static async Task HandleDeleteCompleteAsync(DeleteCompleteContext ctx)
    {
        var coordinator = ctx.HttpContext.RequestServices.GetRequiredService<RecordingUploadCoordinator>();
        await coordinator.HandleTusFileDeletedAsync(ctx.FileId, ctx.CancellationToken);
    }

    private static bool TryReadGuidMetadata(
        Dictionary<string, Metadata> metadata,
        string key,
        out Guid parsedGuid)
    {
        parsedGuid = Guid.Empty;
        if (!metadata.TryGetValue(key, out var entry) || entry.HasEmptyValue)
        {
            return false;
        }

        var raw = entry.GetString(Encoding.UTF8)?.Trim();
        return Guid.TryParse(raw, out parsedGuid) && parsedGuid != Guid.Empty;
    }
}
