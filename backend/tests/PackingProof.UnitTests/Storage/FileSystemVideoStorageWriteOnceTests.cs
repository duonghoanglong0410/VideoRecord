using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using PackingProof.Core.Enums;
using PackingProof.Core.Storage;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Storage;
using Xunit;

namespace PackingProof.UnitTests.Storage;

public sealed class FileSystemVideoStorageWriteOnceTests
{
    [Theory]
    [InlineData(@"\\YNDXY\DataWeb\ecommerce\video_donggoi", "YNDXY", @"\\YNDXY\DataWeb")]
    [InlineData(@"\\192.168.1.38\DataWeb", "192.168.1.38", @"\\192.168.1.38\DataWeb")]
    public void TryExtractUncServerAndShare_ParsesValidUncShareRoots(
        string uncPath,
        string expectedServer,
        string expectedShareRoot)
    {
        var ok = WindowsUncShareConnector.TryExtractUncServerAndShare(
            uncPath,
            out var serverName,
            out var shareRoot);

        Assert.True(ok);
        Assert.Equal(expectedServer, serverName);
        Assert.Equal(expectedShareRoot, shareRoot);
    }

    [Theory]
    [InlineData("")]
    [InlineData("./.local-data/storage")]
    [InlineData(@"D:\Videos\Storage")]
    [InlineData(@"\\OnlyServerName")]
    public void TryExtractUncServerAndShare_RejectsNonUncOrIncompletePaths(string nonUncPath)
    {
        var ok = WindowsUncShareConnector.TryExtractUncServerAndShare(
            nonUncPath,
            out _,
            out _);

        Assert.False(ok);
    }

    [Fact]
    public void BuildCandidateUsernames_PrependsServerPrefixWhenDomainMissing()
    {
        var bareCandidates = WindowsUncShareConnector.BuildCandidateUsernames("YNDXY", "YNDXY-MEMBER");
        Assert.Equal([@"YNDXY\YNDXY-MEMBER", "YNDXY-MEMBER"], bareCandidates);

        var qualifiedCandidates = WindowsUncShareConnector.BuildCandidateUsernames("YNDXY", @"YNDXY\YNDXY-MEMBER");
        Assert.Equal([@"YNDXY\YNDXY-MEMBER"], qualifiedCandidates);
    }

    [Fact]
    public async Task SynologyMounted_WriteOnceMode_CommitsDirectlyWithoutPartialFiles_VerifiesSha256_AndLeavesZeroProbeTmpFiles()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), $"packingproof_worm_ut_{Guid.NewGuid():N}");
        var nasRoot = Path.Combine(tempRoot, "nas-worm-share");
        var stagingRoot = Path.Combine(tempRoot, "staging");
        Directory.CreateDirectory(nasRoot);
        Directory.CreateDirectory(stagingRoot);

        try
        {
            const string storageId = "yndxy-nas-video-donggoi-01";
            await File.WriteAllTextAsync(
                Path.Combine(nasRoot, FileSystemVideoStorage.StorageMarkerFileName),
                storageId,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

            var options = new PackingProofOptions
            {
                StorageMode = StorageMode.SynologyMounted,
                NasRootPath = nasRoot,
                StorageId = storageId,
                StagingRootPath = stagingRoot,
                NasWriteOnceMode = true
            };

            var storage = new FileSystemVideoStorage(options, NullLogger<FileSystemVideoStorage>.Instance);

            // 1. Health check succeeds and creates ZERO .packingproof-rw-probe-*.tmp files
            var health1 = await storage.CheckHealthAsync();
            var health2 = await storage.CheckHealthAsync();
            Assert.True(health1.IsHealthy);
            Assert.True(health2.IsHealthy);
            Assert.True(health2.CanReadWrite);
            Assert.Empty(Directory.GetFiles(nasRoot, "*.tmp", SearchOption.AllDirectories));
            Assert.True(Directory.Exists(Path.Combine(nasRoot, FileSystemVideoStorage.WriteOnceHealthDirectoryName)));

            // 2. CommitFromStagingAsync writes directly to target path with SHA-256 read-back verification
            var payload = Encoding.UTF8.GetBytes("PACKINGPROOF-WORM-VIDEO-EVIDENCE-PAYLOAD-2026");
            var expectedSha256 = Convert.ToHexStringLower(SHA256.HashData(payload));
            var stagingFile = Path.Combine(stagingRoot, "upload_01.bin");
            await File.WriteAllBytesAsync(stagingFile, payload);

            const string relPath = "shop-a/2026/10/31/VN123456/VN123456_11111111-2222-3333-4444-555555555555.webm";
            var receipt = await storage.CommitFromStagingAsync(
                stagingFilePath: stagingFile,
                targetRelativePath: relPath,
                expectedBytes: payload.Length,
                expectedSha256: expectedSha256,
                leaseToken: "worker-01");

            Assert.False(receipt.ReconciledExisting);
            Assert.Equal(payload.Length, receipt.SizeBytes);
            Assert.Equal(expectedSha256, receipt.Sha256);
            Assert.Empty(Directory.GetFiles(nasRoot, "*.partial", SearchOption.AllDirectories));

            // 3. Re-running CommitFromStagingAsync against identical pre-existing file reconciles cleanly
            var reconciled = await storage.CommitFromStagingAsync(
                stagingFilePath: stagingFile,
                targetRelativePath: relPath,
                expectedBytes: payload.Length,
                expectedSha256: expectedSha256,
                leaseToken: "worker-02");

            Assert.True(reconciled.ReconciledExisting);
            Assert.Equal(expectedSha256, reconciled.Sha256);

            // 4. Attempting to commit different content to an existing path throws StorageConflictException
            var differentSha = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("DIFFERENT")));
            await Assert.ThrowsAsync<StorageConflictException>(() =>
                storage.CommitFromStagingAsync(
                    stagingFilePath: stagingFile,
                    targetRelativePath: relPath,
                    expectedBytes: payload.Length,
                    expectedSha256: differentSha,
                    leaseToken: "worker-03"));
        }
        finally
        {
            if (Directory.Exists(tempRoot))
            {
                Directory.Delete(tempRoot, recursive: true);
            }
        }
    }
}

