import { Component, signal, computed, inject, effect, ViewChild, ElementRef, NgZone, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EncoderService, DecodedAudio } from './services/encoder.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
})
export class AppComponent implements OnInit, OnDestroy {
  private encoderService = inject(EncoderService);
  private ngZone = inject(NgZone);

  @ViewChild('audioPlayer') audioPlayer?: ElementRef<HTMLAudioElement>;
  @ViewChild('vinylContainer') vinylContainer?: ElementRef<HTMLDivElement>;

  // Global State
  mode = signal<'encode' | 'decode'>('encode');
  isProcessing = signal<boolean>(false);
  error = signal<string | null>(null);
  showInfo = signal<boolean>(false);

  // Encode State
  encodeType = signal<'noise' | 'stego'>('stego');
  density = signal<number>(3); // 1-7
  selectedAudioFile = signal<File | null>(null);
  selectedCoverImage = signal<File | null>(null);
  coverImagePreview = signal<string | null>(null);
  
  generatedImageUrl = signal<string | null>(null);
  imageDimensions = signal<string>('');

  // Decode State
  selectedImageFile = signal<File | null>(null);
  decodedResult = signal<DecodedAudio | null>(null);
  decodedAudioUrl = signal<string | null>(null);
  decodedCoverUrl = signal<string | null>(null);

  // Player State
  isPlaying = signal<boolean>(false);
  isTonearmOnRecord = signal<boolean>(false); // Starts off
  isScratching = signal<boolean>(false);
  
  // Physics / Animation State
  rotationAngle = signal<number>(0);
  private _reqId: number | null = null;
  private _lastTimestamp: number = 0;
  
  // Scratching Internal State
  private scratchStartAngle = 0;
  private initialScratchRotation = 0;
  
  constructor() {
    // Auto-clean previews
    effect(() => {
        const prev = this.coverImagePreview();
        return () => { if (prev) URL.revokeObjectURL(prev); };
    });
    
    // Auto-clean decode cover
    effect(() => {
        const prev = this.decodedCoverUrl();
        return () => { if (prev) URL.revokeObjectURL(prev); };
    });

    // Auto-play effect when Tonearm drops
    effect(() => {
        const armOn = this.isTonearmOnRecord();
        const audio = this.audioPlayer?.nativeElement;
        
        if (audio && this.decodedAudioUrl()) {
            if (armOn && !this.isScratching()) {
                audio.play().catch(e => console.warn("Autoplay blocked or failed", e));
            } else {
                audio.pause();
            }
        }
    });
  }

  ngOnInit() {
    // Start Animation Loop outside Angular Zone for performance
    this.ngZone.runOutsideAngular(() => {
        this._reqId = requestAnimationFrame(this.animate.bind(this));
    });
  }

  ngOnDestroy() {
      if (this._reqId) cancelAnimationFrame(this._reqId);
  }

  // --- Physics Loop ---
  animate(timestamp: number) {
      const dt = timestamp - this._lastTimestamp;
      this._lastTimestamp = timestamp;

      // Determine Target Speed (degrees per ms)
      // 33.3 RPM = 200 deg/s = 0.2 deg/ms
      // Processing Speed = 800 deg/s = 0.8 deg/ms
      let speed = 0;

      if (this.isProcessing()) {
          speed = 0.8;
      } else if (this.isPlaying() && !this.isScratching()) {
          speed = 0.2;
      }

      if (speed > 0) {
          // Update rotation
          const newAngle = (this.rotationAngle() + speed * dt) % 360;
          this.ngZone.run(() => {
             this.rotationAngle.set(newAngle);
          });
      }

      this._reqId = requestAnimationFrame(this.animate.bind(this));
  }

  // --- Interaction: Info Modal ---
  toggleInfo() {
      this.showInfo.update(v => !v);
  }

  // --- Audio Player Events ---
  
  onAudioPlay() {
      this.isPlaying.set(true);
      if (!this.isTonearmOnRecord()) this.isTonearmOnRecord.set(true);
  }

  onAudioPause() {
      this.isPlaying.set(false);
  }

  onAudioEnded() {
      this.isPlaying.set(false);
      this.isTonearmOnRecord.set(false); 
  }

  // --- Interaction: Tonearm ---

  toggleTonearm() {
      this.isTonearmOnRecord.update(v => !v);
  }

  // --- Interaction: Vinyl Scrubbing ---

  startScratch(event: MouseEvent) {
      if (!this.decodedAudioUrl() || !this.vinylContainer) return;
      event.preventDefault();
      
      this.isScratching.set(true);
      
      const rect = this.vinylContainer.nativeElement.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      // Calculate initial angle of mouse relative to center
      this.scratchStartAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
      // Store the vinyl's current rotation so we can offset from it
      this.initialScratchRotation = this.rotationAngle();

      const audio = this.audioPlayer?.nativeElement;
      if (audio) audio.pause(); 

      const onMove = (e: MouseEvent) => {
          const currentMouseAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
          let deltaRadians = currentMouseAngle - this.scratchStartAngle;
          
          // Convert radians to degrees for visual rotation
          const deltaDegrees = deltaRadians * (180 / Math.PI);
          
          // Update Visual Rotation Immediately
          this.ngZone.run(() => {
            this.rotationAngle.set((this.initialScratchRotation + deltaDegrees) % 360);
          });

          // Handle Seeking logic
          // Normalize Delta (-PI to PI) for seeking calculation to avoid jump at crossover
          if (deltaRadians > Math.PI) deltaRadians -= 2 * Math.PI;
          if (deltaRadians < -Math.PI) deltaRadians += 2 * Math.PI;

          // Sensitivity: 1 Full Rotation (2PI) = 5 seconds of audio
          const seekDelta = (deltaRadians / (2 * Math.PI)) * 5; 
          
          if (audio) {
              let newTime = audio.currentTime + seekDelta;
              // Clamp
              if (newTime < 0) newTime = 0;
              if (newTime > audio.duration) newTime = audio.duration;
              audio.currentTime = newTime;
          }
          
          // Re-center start angle to avoid accumulation drift
          this.scratchStartAngle = currentMouseAngle;
          this.initialScratchRotation = this.rotationAngle();
      };

      const onUp = () => {
          this.isScratching.set(false);
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          
          if (this.isTonearmOnRecord() && audio) {
             audio.play().catch(e => {});
          }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
  }

  // --- Encoding Handlers ---

  onAudioSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      if (file.size > 50 * 1024 * 1024) { 
        this.error.set("File too large. Please keep under 50MB.");
        return;
      }
      this.selectedAudioFile.set(file);
      this.error.set(null);
      this.generatedImageUrl.set(null);
    }
  }

  onCoverImageSelected(event: Event) {
      const input = event.target as HTMLInputElement;
      if (input.files && input.files.length > 0) {
          const file = input.files[0];
          this.selectedCoverImage.set(file);
          this.coverImagePreview.set(URL.createObjectURL(file));
          this.generatedImageUrl.set(null);
          this.error.set(null);
      }
  }

  async generateImage() {
    const audio = this.selectedAudioFile();
    if (!audio) return;

    this.isProcessing.set(true);
    this.error.set(null);

    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      
      let dataUrl: string;
      const type = this.encodeType();

      if (type === 'stego') {
          const cover = this.selectedCoverImage();
          if (!cover) throw new Error("Cover image is required for Stego mode.");
          dataUrl = await this.encoderService.hideDataInImage(audio, cover, this.density());
      } else {
          // Noise mode
          dataUrl = await this.encoderService.encodeFileToImage(audio);
      }
      
      // Update dimensions
      const img = new Image();
      img.onload = () => {
        this.imageDimensions.set(`${img.width} x ${img.height} px`);
      };
      img.src = dataUrl;

      this.generatedImageUrl.set(dataUrl);
    } catch (err: unknown) {
      console.error(err);
      this.error.set((err instanceof Error ? err.message : 'Unknown encoding error'));
    } finally {
      this.isProcessing.set(false);
    }
  }

  downloadImage() {
    const url = this.generatedImageUrl();
    if (!url) return;
    
    const link = document.createElement('a');
    link.href = url;
    link.download = `sonic_pixel_${this.encodeType()}_${Date.now()}.png`;
    link.click();
  }

  setMode(m: 'encode' | 'decode') {
    this.mode.set(m);
    this.resetState();
  }

  setEncodeType(t: 'noise' | 'stego') {
      this.encodeType.set(t);
      this.generatedImageUrl.set(null);
      this.error.set(null);
  }

  onDensityChange(event: Event) {
      const val = parseInt((event.target as HTMLInputElement).value, 10);
      this.density.set(val);
      this.generatedImageUrl.set(null);
  }

  resetState() {
    this.error.set(null);
    this.isProcessing.set(false);
    
    // Clear encode
    this.selectedAudioFile.set(null);
    this.selectedCoverImage.set(null);
    this.coverImagePreview.set(null);
    this.generatedImageUrl.set(null);
    this.imageDimensions.set('');
    this.density.set(3);
    
    // Clear decode
    this.selectedImageFile.set(null);
    this.decodedResult.set(null);
    this.decodedCoverUrl.set(null);
    if (this.decodedAudioUrl()) {
      URL.revokeObjectURL(this.decodedAudioUrl()!);
      this.decodedAudioUrl.set(null);
    }
    
    // Reset Player
    this.isPlaying.set(false);
    this.isTonearmOnRecord.set(false);
    this.isScratching.set(false);
    this.rotationAngle.set(0);
  }

  // --- Decoding Handlers ---

  onImageSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.selectedImageFile.set(input.files[0]);
      this.error.set(null);
      this.decodedResult.set(null);
      this.decodedCoverUrl.set(null);
    }
  }

  async decodeImage() {
    const file = this.selectedImageFile();
    if (!file) return;

    this.isProcessing.set(true);
    this.error.set(null);

    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const result = await this.encoderService.decodeImageToFile(file);
      this.decodedResult.set(result);
      
      const url = URL.createObjectURL(result.blob);
      this.decodedAudioUrl.set(url);
      this.decodedCoverUrl.set(URL.createObjectURL(file));
      
      // Auto-Drop Arm to indicate readiness
      this.isTonearmOnRecord.set(true);

    } catch (err: unknown) {
      console.error(err);
      this.error.set('Decoding failed. Ensure this is a valid Sonic Pixelator image (Standard or Stego).');
    } finally {
      this.isProcessing.set(false);
    }
  }
}