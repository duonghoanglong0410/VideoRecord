using PackingProof.Infrastructure.Storage;
using Xunit;

namespace PackingProof.UnitTests.Storage;

public sealed class StoragePathBuilderTests
{
    [Fact]
    public void BuildOriginalRelativePath_ConvertsUtcLateEveningToNextDayInHoChiMinh_AndSanitizesSegments()
    {
        var recordingId = Guid.Parse("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");
        // 2026-12-31 19:15:00 UTC == 2027-01-01 02:15:00 in Asia/Ho_Chi_Minh (UTC+7)
        var utcTimestamp = new DateTime(2026, 12, 31, 19, 15, 0, DateTimeKind.Utc);

        var path = StoragePathBuilder.BuildOriginalRelativePath(
            shopSlug: "shop-a",
            utcTimestamp: utcTimestamp,
            safeTrackingSegment: "001234567890",
            recordingId: recordingId,
            verifiedContainer: "webm");

        Assert.Equal(
            "shop-a/2027/01/01/001234567890/001234567890_a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.webm",
            path);
    }

    [Fact]
    public void BuildPreviewRelativePath_UsesIdenticalHoChiMinhFolderAndAppendsPreviewMp4Suffix()
    {
        var recordingId = Guid.Parse("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");
        var utcTimestamp = new DateTime(2026, 12, 31, 19, 15, 0, DateTimeKind.Utc);

        var previewPath = StoragePathBuilder.BuildPreviewRelativePath(
            shopSlug: "shop-a",
            utcTimestamp: utcTimestamp,
            safeTrackingSegment: "001234567890",
            recordingId: recordingId);

        Assert.Equal(
            "shop-a/2027/01/01/001234567890/001234567890_a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d_preview.mp4",
            previewPath);
    }

    [Theory]
    [InlineData("webm", ".webm")]
    [InlineData("MP4", ".mp4")]
    [InlineData("mkv", ".mkv")]
    [InlineData("mov", ".mov")]
    public void ResolveVerifiedExtension_AcceptsSupportedVerifiedContainers(string container, string expectedExtension)
    {
        Assert.Equal(expectedExtension, StoragePathBuilder.ResolveVerifiedExtension(container));
    }

    [Theory]
    [InlineData("")]
    [InlineData("exe")]
    [InlineData("avi")]
    [InlineData("../mp4")]
    public void ResolveVerifiedExtension_RejectsUnsupportedOrUntrustedContainerStrings(string invalidContainer)
    {
        Assert.Throws<ArgumentException>(() => StoragePathBuilder.ResolveVerifiedExtension(invalidContainer));
    }
}

