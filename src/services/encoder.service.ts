import { Injectable } from '@angular/core';

export interface DecodedAudio {
  blob: Blob;
  fileName: string;
  fileType: string;
}

@Injectable({
  providedIn: 'root'
})
export class EncoderService {
  private readonly MAGIC_SNIC = [0x53, 0x4E, 0x49, 0x43]; // "SNIC" - Standard Noise Image Content (Raw)
  private readonly MAGIC_SNIZ = [0x53, 0x4E, 0x49, 0x5A]; // "SNIZ" - Sonic Image Zip (Compressed)
  private readonly MAGIC_SNIH = [0x53, 0x4E, 0x49, 0x48]; // "SNIH" - Sonic Hidden (Stego Header)
  private readonly RESERVED_HEADER_PIXELS = 32; // Pixels reserved for Magic, Length, BPC (Linear access)

  /**
   * Generates a "Noise" image where every pixel is data.
   */
  async encodeFileToImage(file: File): Promise<string> {
    const fullBuffer = await this.createPayload(file);
    
    // Calculate required pixels (3 bytes per pixel: R, G, B)
    const totalPixels = Math.ceil(fullBuffer.length / 3);
    const width = Math.ceil(Math.sqrt(totalPixels));
    const height = Math.ceil(totalPixels / width);
    
    // Create Canvas Image Data
    const finalImageData = new Uint8ClampedArray(width * height * 4);
    
    let bufferIdx = 0;
    for (let i = 0; i < width * height; i++) {
      const pixelIdx = i * 4;
      
      finalImageData[pixelIdx] = bufferIdx < fullBuffer.length ? fullBuffer[bufferIdx++] : 0; // R
      finalImageData[pixelIdx + 1] = bufferIdx < fullBuffer.length ? fullBuffer[bufferIdx++] : 0; // G
      finalImageData[pixelIdx + 2] = bufferIdx < fullBuffer.length ? fullBuffer[bufferIdx++] : 0; // B
      finalImageData[pixelIdx + 3] = 255; // Alpha - Must be opaque
    }
    
    return this.renderToCanvas(width, height, finalImageData);
  }

  /**
   * Hides the file data INSIDE the provided cover image using LSB steganography.
   */
  async hideDataInImage(audioFile: File, coverImage: File, targetBPC: number = 3): Promise<string> {
    const payload = await this.createPayload(audioFile);
    
    // We use a simplified loading strategy here. 
    // We want the raw RGB values.
    let img: ImageBitmap;
    try {
        img = await createImageBitmap(coverImage, { 
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none'
        });
    } catch (e) {
        console.warn("Strict bitmap creation failed, falling back", e);
        img = await createImageBitmap(coverImage);
    }
    
    const totalPayloadBits = payload.length * 8;
    
    const width = img.width;
    const height = img.height;
    
    // Calculate Capacity
    const availablePixels = (width * height) - this.RESERVED_HEADER_PIXELS;
    
    // Logic: Determine scale needed.
    const minRequiredBPC = Math.ceil(totalPayloadBits / (availablePixels * 3));
    
    let scale = 1.0;

    // Condition A: Data physically doesn't fit at desired density. Upscale to fit.
    if (minRequiredBPC > targetBPC) {
         const desiredChannels = Math.ceil(totalPayloadBits / targetBPC);
         const desiredPixels = Math.ceil(desiredChannels / 3) + this.RESERVED_HEADER_PIXELS;
         scale = Math.sqrt(desiredPixels / (width * height));
    }

    // Condition B: Image is "small" relative to payload.
    // Ensure we have at least 2x the pixels needed for the payload if possible (50% utilization max).
    const utilization = totalPayloadBits / (availablePixels * 3 * targetBPC);
    if (utilization > 0.5 && scale === 1.0) {
        scale = 1.25; 
    }

    // Ensure integers
    scale = Math.max(1, scale);
    const newWidth = Math.ceil(width * scale);
    const newHeight = Math.ceil(height * scale);
    
    const finalBPC = targetBPC;

    const canvas = document.createElement('canvas');
    canvas.width = newWidth;
    canvas.height = newHeight;
    
    // Simplified Context: Use default color space to match browser display behavior
    // willReadFrequently optimizes for readback speed and software rendering accuracy
    const ctx = canvas.getContext('2d', { 
        willReadFrequently: true, 
        alpha: false 
    });
    if (!ctx) throw new Error('Canvas context failed');
    
    // Draw with smoothing for quality upscale if we are scaling
    if (scale > 1.0) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
    } else {
        ctx.imageSmoothingEnabled = false;
    }

    ctx.drawImage(img, 0, 0, newWidth, newHeight);
    
    const imageData = ctx.getImageData(0, 0, newWidth, newHeight);
    const pixels = imageData.data;

    // Force Opaque Alpha (255) to ensure stability when saving as PNG
    for (let i = 3; i < pixels.length; i += 4) {
      pixels[i] = 255;
    }

    // --- Write Header (Linear - First 32 pixels) ---
    const headerBits: number[] = [];
    
    this.MAGIC_SNIH.forEach(byte => {
      for(let b=0; b<8; b++) headerBits.push((byte >> b) & 1);
    });
    
    const len = payload.length;
    for(let b=0; b<32; b++) headerBits.push((len >> b) & 1);
    
    for(let b=0; b<8; b++) headerBits.push((finalBPC >> b) & 1);
    
    let channelIdx = 0; 
    let pixelIdx = 0;
    
    for (let i = 0; i < headerBits.length; i++) {
      const pIdx = pixelIdx * 4 + channelIdx;
      // Header always uses 1 bit LSB (Standard)
      pixels[pIdx] = (pixels[pIdx] & ~1) | headerBits[i];
      
      channelIdx++;
      if (channelIdx > 2) { channelIdx = 0; pixelIdx++; }
    }

    // --- Write Payload (Scattered with OPAP) ---
    const shuffledIndices = this.getShuffledIndices(newWidth * newHeight, this.RESERVED_HEADER_PIXELS);
    
    let payloadByteIdx = 0;
    let payloadBitIdx = 0;
    let shuffleArrIdx = 0;
    
    const mask = (1 << finalBPC) - 1;
    
    while (payloadByteIdx < payload.length) {
      if (shuffleArrIdx >= shuffledIndices.length) break; 
      
      const targetPixelIndex = shuffledIndices[shuffleArrIdx];
      
      // We have 3 channels (RGB) per pixel
      for (let c = 0; c < 3; c++) {
          const pIdx = targetPixelIndex * 4 + c;
          
          let bitsToEmbed = 0;
          
          for (let b = 0; b < finalBPC; b++) {
            if (payloadByteIdx < payload.length) {
              const bit = (payload[payloadByteIdx] >> payloadBitIdx) & 1;
              bitsToEmbed |= (bit << b);
              
              payloadBitIdx++;
              if (payloadBitIdx === 8) {
                payloadBitIdx = 0;
                payloadByteIdx++;
              }
            }
          }

          const originalVal = pixels[pIdx];
          // 1. Basic Substitution
          let modifiedVal = (originalVal & ~mask) | bitsToEmbed;
          
          // 2. Optimal Pixel Adjustment Process (OPAP)
          if (finalBPC < 8) {
              modifiedVal = this.applyOPAP(originalVal, modifiedVal, finalBPC);
          }

          pixels[pIdx] = modifiedVal;
          
          if (payloadByteIdx >= payload.length && payloadBitIdx === 0) break;
      }

      shuffleArrIdx++;
    }
    
    ctx.putImageData(imageData, 0, 0);
    
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) resolve(URL.createObjectURL(blob));
            else reject(new Error('Image generation failed'));
        }, 'image/png');
    });
  }

  /**
   * Decodes an image (Standard or Stego) back to audio.
   */
  async decodeImageToFile(imageFile: File): Promise<DecodedAudio> {
    // Decoding Strategy:
    // We use the browser's standard image decoding. 
    // We do NOT enforce strict color profiles here because we want to read the image 
    // exactly as the browser interprets it for the canvas, matching the 'toBlob' behavior.
    let img: ImageBitmap;
    try {
        // Try strict first for best fidelity if supported
        img = await createImageBitmap(imageFile, { 
            premultiplyAlpha: 'none', 
            colorSpaceConversion: 'none' 
        });
    } catch (e) {
        // Fallback to standard
        img = await createImageBitmap(imageFile);
    }

    const width = img.width;
    const height = img.height;
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    if (!ctx) throw new Error('Could not get canvas context');
    
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    const pixels = imageData.data;
    
    // --- Detection Phase ---
    
    // 1. Check for Standard "Noise" (SNIC/SNIZ)
    const rawCheck = new Uint8Array([pixels[0], pixels[1], pixels[2], pixels[4]]);
    let isStandardRaw = true;
    let isStandardZip = true;
    
    for(let i=0; i<4; i++) {
      if (rawCheck[i] !== this.MAGIC_SNIC[i]) isStandardRaw = false;
      if (rawCheck[i] !== this.MAGIC_SNIZ[i]) isStandardZip = false;
    }
    
    if (isStandardRaw || isStandardZip) {
      return this.decodeStandardImage(pixels, width, height);
    }
    
    // 2. Check for Stego Image (SNIH)
    // Read 32 bits strictly from LSBs of first pixels
    const stegoMagicBuffer = new Uint8Array(4);
    let channelIdx = 0;
    let pixelIdx = 0;
    
    for(let byteI=0; byteI<4; byteI++) {
      let byteVal = 0;
      for(let bitI=0; bitI<8; bitI++) {
        const pIdx = pixelIdx * 4 + channelIdx;
        const bit = pixels[pIdx] & 1;
        byteVal |= (bit << bitI);
        
        channelIdx++;
        if(channelIdx > 2) { channelIdx = 0; pixelIdx++; }
      }
      stegoMagicBuffer[byteI] = byteVal;
    }
    
    let isStego = true;
    for(let i=0; i<4; i++) {
      if (stegoMagicBuffer[i] !== this.MAGIC_SNIH[i]) isStego = false;
    }

    if (isStego) {
      return this.decodeStegoImage(pixels, width, height, pixelIdx, channelIdx); 
    }

    throw new Error('This image does not contain valid Sonic Pixelator data. Please ensure you uploaded the correct PNG file.');
  }

  // --- Private Helpers ---

  private applyOPAP(original: number, modified: number, bpc: number): number {
    const delta = modified - original;
    const interval = 1 << bpc; 
    const limit = 1 << (bpc - 1); 

    if (delta > limit && (modified - interval) >= 0) {
        return modified - interval;
    } else if (delta < -limit && (modified + interval) <= 255) {
        return modified + interval;
    }
    return modified;
  }

  private getShuffledIndices(totalPixels: number, reservedPixels: number): Uint32Array {
    const count = totalPixels - reservedPixels;
    const indices = new Uint32Array(count);
    for(let i=0; i<count; i++) indices[i] = reservedPixels + i;
    
    let seed = 1337 ^ 0xDEADBEEF; 
    const random = () => {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    
    for (let i = count - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const temp = indices[i];
        indices[i] = indices[j];
        indices[j] = temp;
    }
    return indices;
  }

  // DEPRECATED for writing, kept for reading legacy files
  private async compressData(data: Uint8Array): Promise<Uint8Array> {
    // DISABLE COMPRESSION to improve robustness. Audio is already compressed.
    // Gzip fragility is the #1 cause of failure in pixel storage.
    return data;
  }

  private async decompressData(data: Uint8Array): Promise<Uint8Array> {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      console.error("Decompression failed", e);
      throw new Error("Failed to decompress audio data. The image pixels may have been altered by the browser or compression.");
    }
  }

  private async createPayload(file: File): Promise<Uint8Array> {
    const arrayBuffer = await file.arrayBuffer();
    const rawDataBytes = new Uint8Array(arrayBuffer);
    
    // Skip compression for stability. 
    // const compressedData = await this.compressData(rawDataBytes);
    // const isCompressed = compressedData.length < rawDataBytes.length;
    
    // Always use Raw mode (SNIC) for new files to ensure 1:1 bit reliability
    const isCompressed = false;
    const magic = this.MAGIC_SNIC;
    const finalData = rawDataBytes;

    const mimeBytes = new TextEncoder().encode(file.type);
    const nameBytes = new TextEncoder().encode(file.name);
    
    const headerSize = 4 + 4 + 1 + mimeBytes.length + 1 + nameBytes.length;
    const totalPayloadSize = headerSize + finalData.length;
    const fullBuffer = new Uint8Array(totalPayloadSize);
    let offset = 0;
    
    magic.forEach(b => fullBuffer[offset++] = b);
    
    const sizeView = new DataView(new ArrayBuffer(4));
    sizeView.setUint32(0, finalData.length, true);
    fullBuffer.set(new Uint8Array(sizeView.buffer), offset);
    offset += 4;
    
    fullBuffer[offset++] = mimeBytes.length;
    fullBuffer.set(mimeBytes, offset);
    offset += mimeBytes.length;
    
    fullBuffer[offset++] = nameBytes.length;
    fullBuffer.set(nameBytes, offset);
    offset += nameBytes.length;
    
    fullBuffer.set(finalData, offset);
    return fullBuffer;
  }

  private async parsePayload(buffer: Uint8Array): Promise<DecodedAudio> {
    let ptr = 0;
    
    const magicCheck = buffer.slice(0, 4);
    let isSnic = true;
    let isSniz = true;
    
    for(let i=0; i<4; i++) {
        if(magicCheck[i] !== this.MAGIC_SNIC[i]) isSnic = false;
        if(magicCheck[i] !== this.MAGIC_SNIZ[i]) isSniz = false;
    }
    
    if (!isSnic && !isSniz) throw new Error('Data Extraction Error: The hidden payload could not be verified (Invalid Inner Magic). Pixels may have been altered.');
    
    const isCompressed = isSniz; // Only decompress if explicitly marked as SNIZ
    
    ptr += 4;
    
    const sizeView = new DataView(buffer.slice(ptr, ptr + 4).buffer);
    const dataSize = sizeView.getUint32(0, true);
    ptr += 4;
    
    if (ptr + 1 > buffer.length) throw new Error("Header Read Error: Buffer truncated.");
    const mimeLen = buffer[ptr++];
    
    if (ptr + mimeLen > buffer.length) throw new Error("Header Read Error: Mime length overflow.");
    const mimeType = new TextDecoder().decode(buffer.slice(ptr, ptr + mimeLen));
    ptr += mimeLen;
    
    if (ptr + 1 > buffer.length) throw new Error("Header Read Error: Buffer truncated.");
    const nameLen = buffer[ptr++];
    
    if (ptr + nameLen > buffer.length) throw new Error("Header Read Error: Name length overflow.");
    const fileName = new TextDecoder().decode(buffer.slice(ptr, ptr + nameLen));
    ptr += nameLen;
    
    if (ptr + dataSize > buffer.length) {
        console.warn(`Buffer mismatch. Expected ${ptr+dataSize}, got ${buffer.length}. Attempting partial read.`);
        // In some cases (Noise mode), the buffer might be slightly larger due to pixel padding, which is fine.
        // If it's smaller, we have data loss.
    }
    
    // Safe slice
    let fileData = buffer.slice(ptr, Math.min(ptr + dataSize, buffer.length));
    
    if (isCompressed) {
        fileData = await this.decompressData(fileData);
    }
    
    const blob = new Blob([fileData], { type: mimeType });
    
    return { blob, fileName, fileType: mimeType };
  }

  private async decodeStandardImage(pixels: Uint8ClampedArray, width: number, height: number): Promise<DecodedAudio> {
    const extractedBuffer = new Uint8Array(width * height * 3);
    let ptr = 0;
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      extractedBuffer[ptr++] = pixels[idx];
      extractedBuffer[ptr++] = pixels[idx + 1];
      extractedBuffer[ptr++] = pixels[idx + 2];
    }
    return this.parsePayload(extractedBuffer);
  }

  private async decodeStegoImage(pixels: Uint8ClampedArray, width: number, height: number, startPixelIdx: number, startChannelIdx: number): Promise<DecodedAudio> {
    let pixelIdx = startPixelIdx;
    let channelIdx = startChannelIdx;

    const readByte = () => {
      let val = 0;
      for(let b=0; b<8; b++) {
        const pIdx = pixelIdx * 4 + channelIdx;
        const bit = pixels[pIdx] & 1;
        val |= (bit << b);
        channelIdx++;
        if (channelIdx > 2) { channelIdx = 0; pixelIdx++; }
      }
      return val;
    };

    // Read Length (32 bits / 4 bytes)
    const lenBytes = new Uint8Array(4);
    for(let i=0; i<4; i++) lenBytes[i] = readByte();
    const payloadLen = new DataView(lenBytes.buffer).getUint32(0, true);

    // Read BPC (8 bits / 1 byte)
    const bpc = readByte();
    
    if (bpc < 1 || bpc > 8) throw new Error("Invalid BPC detected in header.");
    if (payloadLen > (width * height * 3 * bpc)) throw new Error("Header payload length exceeds image capacity.");

    // Generate indices
    const shuffledIndices = this.getShuffledIndices(width * height, this.RESERVED_HEADER_PIXELS);
    
    const payload = new Uint8Array(payloadLen);
    let payloadByteIdx = 0;
    let payloadBitIdx = 0;
    let currentByte = 0;
    let shuffleArrIdx = 0;
    
    const mask = (1 << bpc) - 1;

    while(payloadByteIdx < payloadLen) {
        if (shuffleArrIdx >= shuffledIndices.length) break;

        const targetPixelIndex = shuffledIndices[shuffleArrIdx];

        // Iterate RGB channels of this pixel
        for (let c=0; c<3; c++) {
            const pIdx = targetPixelIndex * 4 + c;
            const bits = pixels[pIdx] & mask;
            
            // Extract BPC bits
            for (let b = 0; b < bpc; b++) {
               const bit = (bits >> b) & 1;
               currentByte |= (bit << payloadBitIdx);
               payloadBitIdx++;
               
               if (payloadBitIdx === 8) {
                   payload[payloadByteIdx] = currentByte;
                   payloadByteIdx++;
                   payloadBitIdx = 0;
                   currentByte = 0;
                   if (payloadByteIdx >= payloadLen) break;
               }
            }
            if (payloadByteIdx >= payloadLen) break;
        }
        
        shuffleArrIdx++;
    }

    return this.parsePayload(payload);
  }

  private renderToCanvas(width: number, height: number, data: Uint8ClampedArray): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    if (!ctx) throw new Error('Context creation failed');
    
    const imageData = new ImageData(data, width, height);
    ctx.putImageData(imageData, 0, 0);
    
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) resolve(URL.createObjectURL(blob));
            else reject(new Error('Image generation failed'));
        }, 'image/png');
    });
  }
}