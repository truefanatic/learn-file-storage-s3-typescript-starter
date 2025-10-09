import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo, type Video } from "../db/videos";
import type { ApiConfig } from "../config";
import { s3, type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "node:path";
import { randomBytes } from "node:crypto";


export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const formData = await req.formData();
  const file = formData.get("video");
  if (file instanceof File) {
    const MAX_UPLOAD_SIZE = 1 * 1024 * 1024 * 1024;
    if (file.size > MAX_UPLOAD_SIZE) {
      throw new BadRequestError(
        "Video file exceeds the maximum allowed size of 1GB"
      );
    }
  } else {
    throw new BadRequestError("Video file missing");
  }

  const mediaType = file.type;

  if (mediaType !== "video/mp4") {
    throw new BadRequestError("Video should be video/mp4");
  }

  const data = await file.arrayBuffer();
  if (!data) {
    throw new Error("Error reading file data");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID != userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const ext = mediaType.split("/")[1];
  const fileName = randomBytes(32).toString("base64url");
  const key = `${fileName}.${ext}`;
  const filePath = path.join(cfg.assetsRoot, key);
  await Bun.write(filePath, data, { createPath: true });

  const aspectRatio = await getVideoAspectRatio(filePath);
  const s3Key = `${aspectRatio}/${key}`;
  const processedFilePath = await processVideoForFastStart(filePath);
  const tmpFile = Bun.file(filePath);
  
  const s3file = cfg.s3Client.file(s3Key, { bucket: cfg.s3Bucket });
  const tmpFileProcessed = Bun.file(processedFilePath);
  await s3file.write(tmpFileProcessed, { type: mediaType });

  video.videoURL = `https://${cfg.s3CfDistribution}/${s3Key}`;
  console.log("videoURL --- " + video.videoURL);

  updateVideo(cfg.db, video);

  await tmpFileProcessed.delete();
  await tmpFile.delete();
  return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filePath: string) {
  const process = Bun.spawn([
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
  ]);

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
  const newFilePath = filePath.concat(".processed");
  console.log(newFilePath);
  const process = Bun.spawn([
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
    newFilePath,
  ]);

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe failed`);
  }
  return newFilePath;
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