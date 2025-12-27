# Sonic Pixelator

Sonic Pixelator is a high-fidelity audio-to-image steganography tool that allows you to store and extract audio recordings within innocent-looking photographs. It features a retro-futuristic "Rack Unit" interface with interactive vinyl physics and CRT-style visuals.

## Methodology & Functioning

Sonic Pixelator utilizes advanced steganography and data visualization techniques to embed audio data into PNG images.

### 1. Encoding Modes

- **Stego Mode (Steganography):** Hides audio data inside a provided cover image.
  - **LSB Substitution:** Data is embedded into the Least Significant Bits of the image pixels.
  - **BPC (Bits Per Channel):** Users can adjust the data density from 1 to 7 bits. Higher density allows for larger audio files but introduces more visible "grain" or noise.
  - **OPAP (Optimal Pixel Adjustment Process):** An optimization technique that reduces visual distortion by adjusting the modified pixel value to be as close to the original as possible.
  - **Pseudo-Random Scattering:** Pixels are selected using a seeded Fisher-Yates shuffle. This ensures that data is distributed evenly across the image rather than in a linear block, making the embedding more robust and less predictable.
- **Noise Mode:** A direct visualization of the audio data. Every pixel in the generated image represents 3 bytes of raw audio data (RGB). This results in a "digital noise" aesthetic where the image is the data itself.

### 2. Robustness & Stability

- **Bit-Perfect Extraction:** The system is designed to handle the nuances of browser-based canvas rendering. It forces opaque alpha channels and uses specific context attributes (`willReadFrequently`) to ensure that the data read back is identical to the data written.
- **Header System:** Every Sonic Pixelator image contains a small, robust header (using 1-bit LSB in the first few pixels) that stores the magic number, file name, MIME type, and data density. This allows the decoder to automatically detect the file type and extraction parameters.
- **Lossless Format:** PNG is used exclusively because it is a lossless compression format. Lossy formats like JPG would destroy the embedded data.

### 3. Interface & Experience

- **Interactive Vinyl Physics:** When an audio file is decoded, it is "loaded" onto a virtual vinyl record. The player features a functioning tonearm and allows for manual "scrubbing" (vinyl scratching) to seek through the audio.
- **CRT Aesthetics:** The UI is inspired by 1980s rack-mounted signal processors, complete with scanlines, glowing LEDs, and chunky industrial buttons.

## Run Locally

**Prerequisites:** Node.js

1. **Install dependencies:**

    ```bash
    npm install
    ```

2. **Run the app:**

    ```bash
    npm run dev
    ```

## Vercel Deployment

This project is ready to be deployed on Vercel. Simply connect your repository to Vercel, and it will automatically detect the settings from `vercel.json` and `package.json`.

---
*Created by Sonic Pixelator Team*
