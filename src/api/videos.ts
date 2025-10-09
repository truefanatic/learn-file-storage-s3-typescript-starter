import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo, type Video } from "../db/videos";
import type { ApiConfig } from "../config";
import { type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { uploadVideoToS3 } from "../s3";
import { rm } from "fs/promises";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30; //1GB

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID != userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File exceeds size limit (1GB)");
  }
  const mediaType = file.type;
  if (file.type !== "video/mp4") {
    throw new BadRequestError("Invalid file type, only MP4 is allowed");
  }

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, file);
  const aspectRatio = await getVideoAspectRatio(tempFilePath);
  const processedFilePath = await processVideoForFastStart(tempFilePath);
  const key = `${aspectRatio}/${videoId}.mp4`;

  await uploadVideoToS3(cfg, key, processedFilePath, "video/mp4");

  const videoURL = `${cfg.s3CfDistribution}/${key}`;
  video.videoURL = videoURL;
  updateVideo(cfg.db, video);

  await Promise.all([
    rm(tempFilePath, { force: true }),
    rm(`${tempFilePath}.processed.mp4`, { force: true }),
  ]);
  return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filePath: string) {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe failed: ${stderr}`);
  }

  const json = JSON.parse(stdout.toString());
  const stream = json.streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error("Could not read video dimensions");
  }

  const { width, height } = stream;

  if (Math.floor(width / height) === Math.floor(16 / 9)) {
    return "landscape";
  } else if (Math.floor(width / height) === Math.floor(9 / 16)) {
    return "portrait";
  } else {
    return "other";
  }
}

async function processVideoForFastStart(filePath: string) {
  const processedFilePath = `${filePath}".processed.mp4`;
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      filePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      processedFilePath,
    ],
    { stderr: "pipe" }
  );

  const errorText = await new Response(process.stderr).text();
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`FFmpeg error: ${errorText}`);
  }

  return processedFilePath;
}

// function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
//   const s3Key = `s3://${cfg.s3Bucket}/${key.replace(/^\/+/, "")}`;
//   console.log("s3Key --- " + s3Key);

//   const url = s3.presign(key, {
//     expiresIn: expireTime, // e.g. 3600 = 1 hour
//     method: "GET",
//     acl: "public-read",
//   });
//   console.log("url --- " + url);
//   return url;
// }

// export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
//   if (!video?.videoURL) return video;

//   // Only the S3 key should be passed
//   const signedURL = generatePresignedURL(cfg, video.videoURL, 3600);
//   return { ...video, videoURL: signedURL };
// }
