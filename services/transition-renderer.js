const transitions = {
    /**
     * Fades the current image out while fading the next image in.
     * @param {CanvasRenderingContext2D} ctx - The 2D rendering context of the canvas.
     * @param {HTMLCanvasElement} canvas - The canvas element.
     * @param {HTMLImageElement} currentImage - The image currently displayed.
     * @param {HTMLImageElement} nextImage - The image to transition to.
     * @param {number} progress - The transition progress (0.0 to 1.0).
     */
    fade: (ctx, canvas, currentImage, nextImage, progress) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw currentImage fading out
        ctx.globalAlpha = 1 - progress;
        ctx.drawImage(currentImage, 0, 0, canvas.width, canvas.height);

        // Draw nextImage fading in
        ctx.globalAlpha = progress;
        ctx.drawImage(nextImage, 0, 0, canvas.width, canvas.height);

        ctx.globalAlpha = 1; // Reset alpha for subsequent draws
    },

    /**
     * Slides the current image out to the left while the next image slides in from the right.
     * @param {CanvasRenderingContext2D} ctx - The 2D rendering context of the canvas.
     * @param {HTMLCanvasElement} canvas - The canvas element.
     * @param {HTMLImageElement} currentImage - The image currently displayed.
     * @param {HTMLImageElement} nextImage - The image to transition to.
     * @param {number} progress - The transition progress (0.0 to 1.0).
     */
    slide_left: (ctx, canvas, currentImage, nextImage, progress) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const currentX = 0 - progress * canvas.width;
        const nextX = canvas.width - progress * canvas.width;

        ctx.drawImage(currentImage, currentX, 0, canvas.width, canvas.height);
        ctx.drawImage(nextImage, nextX, 0, canvas.width, canvas.height);
    },

    /**
     * Zooms the next image in from the center while the current image fades out.
     * @param {CanvasRenderingContext2D} ctx - The 2D rendering context of the canvas.
     * @param {HTMLCanvasElement} canvas - The canvas element.
     * @param {HTMLImageElement} currentImage - The image currently displayed.
     * @param {HTMLImageElement} nextImage - The image to transition to.
     * @param {number} progress - The transition progress (0.0 to 1.0).
     */
    zoom_in: (ctx, canvas, currentImage, nextImage, progress) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw currentImage fading out
        ctx.globalAlpha = 1 - progress;
        ctx.drawImage(currentImage, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;

        // Draw nextImage scaling and fading in from center
        const scale = progress; // Scale from 0 to 1
        const scaledWidth = canvas.width * scale;
        const scaledHeight = canvas.height * scale;
        const dx = (canvas.width - scaledWidth) / 2;
        const dy = (canvas.height - scaledHeight) / 2;

        ctx.globalAlpha = progress;
        ctx.drawImage(nextImage, dx, dy, scaledWidth, scaledHeight);
        ctx.globalAlpha = 1; // Reset alpha
    },

    /**
     * Creates a white flash effect in the middle of the transition.
     * @param {CanvasRenderingContext2D} ctx - The 2D rendering context of the canvas.
     * @param {HTMLCanvasElement} canvas - The canvas element.
     * @param {HTMLImageElement} currentImage - The image currently displayed.
     * @param {HTMLImageElement} nextImage - The image to transition to.
     * @param {number} progress - The transition progress (0.0 to 1.0).
     */
    flash: (ctx, canvas, currentImage, nextImage, progress) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Determine which image to show based on progress
        if (progress < 0.5) {
            ctx.drawImage(currentImage, 0, 0, canvas.width, canvas.height);
        } else {
            ctx.drawImage(nextImage, 0, 0, canvas.width, canvas.height);
        }

        // Flash effect peaking at 0.5
        let flashOpacity = 0;
        if (progress < 0.5) {
            flashOpacity = progress * 2; // Increases from 0 to 1
        } else {
            flashOpacity = (1 - progress) * 2; // Decreases from 1 to 0
        }

        ctx.globalAlpha = flashOpacity;
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1; // Reset alpha
    },

    /**
     * Creates a digital glitch effect by shifting and distorting image segments.
     * Note: This is a simplified approximation without `getImageData` for performance.
     * @param {CanvasRenderingContext2D} ctx - The 2D rendering context of the canvas.
     * @param {HTMLCanvasElement} canvas - The canvas element.
     * @param {HTMLImageElement} currentImage - The image currently displayed.
     * @param {HTMLImageElement} nextImage - The image to transition to.
     * @param {number} progress - The transition progress (0.0 to 1.0).
     */
    glitch: (ctx, canvas, currentImage, nextImage, progress) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Intensity peaks at 0.5, 0 at 0 and 1
        const intensity = 1 - Math.abs(progress - 0.5) * 2;

        const imgToDraw = (progress < 0.5) ? currentImage : nextImage;
        const otherImg = (progress < 0.5) ? nextImage : currentImage;

        // Draw base image (fading current out, next in, with some glitching)
        ctx.globalAlpha = 1 - progress;
        ctx.drawImage(currentImage, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = progress;
        ctx.drawImage(nextImage, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1; // Reset alpha

        if (intensity > 0.05) { // Only apply glitch effects if intensity is significant
            const maxOffset = 20 * intensity; // Max pixel offset based on intensity
            const numGlitchSegments = 30; // Number of small segments to glitch

            // Simulate RGB shift with multiple draws and 'lighter' blend mode
            ctx.globalAlpha = 0.5 * intensity; // Make shifted copies semi-transparent
            ctx.globalCompositeOperation = 'lighter'; // Add colors

            ctx.drawImage(imgToDraw, -maxOffset * 0.5, 0, canvas.width, canvas.height);
            ctx.drawImage(imgToDraw, maxOffset * 0.5, 0, canvas.width, canvas.height);

            ctx.globalCompositeOperation = 'source-over'; // Reset blend mode
            ctx.globalAlpha = 1; // Reset alpha

            // Horizontal line displacement and random blocks for more disruption
            for (let i = 0; i < numGlitchSegments; i++) {
                const y = Math.random() * canvas.height;
                const segmentHeight = 1 + Math.random() * 10;
                const displacement = (Math.random() - 0.5) * maxOffset * 2;

                ctx.drawImage(imgToDraw,
                    0, y, canvas.width, segmentHeight, // Source rect
                    displacement, y, canvas.width, segmentHeight // Dest rect
                );

                // Occasionally draw blocks from the other image for a flicker
                if (Math.random() < intensity * 0.5) {
                    const blockWidth = 5 + Math.random() * 20;
                    const blockHeight = 5 + Math.random() * 20;
                    const blockX = Math.random() * (canvas.width - blockWidth);
                    const blockY = Math.random() * (canvas.height - blockHeight);
                    ctx.drawImage(otherImg,
                        blockX, blockY, blockWidth, blockHeight, // Source
                        blockX, blockY, blockWidth, blockHeight  // Dest
                    );
                }
            }
        }
    },

    /**
     * Spins and scales the current image out while spinning and scaling the next image in.
     * @param {CanvasRenderingContext2D} ctx - The 2D rendering context of the canvas.
     * @param {HTMLCanvasElement} canvas - The canvas element.
     * @param {HTMLImageElement} currentImage - The image currently displayed.
     * @param {HTMLImageElement} nextImage - The image to transition to.
     * @param {number} progress - The transition progress (0.0 to 1.0).
     */
    spin: (ctx, canvas, currentImage, nextImage, progress) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;

        // Current image spins out and scales down
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate(progress * Math.PI); // Rotate 0 to 180 degrees
        const scaleCurrent = 1 - progress; // Scale from 1 to 0
        ctx.scale(scaleCurrent, scaleCurrent);
        ctx.globalAlpha = 1 - progress; // Fade out
        ctx.drawImage(currentImage, -centerX, -centerY, canvas.width, canvas.height);
        ctx.restore();

        // Next image spins in and scales up
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate((progress - 1) * Math.PI); // Rotate -180 to 0 degrees
        const scaleNext = progress; // Scale from 0 to 1
        ctx.scale(scaleNext, scaleNext);
        ctx.globalAlpha = progress; // Fade in
        ctx.drawImage(nextImage, -centerX, -centerY, canvas.width, canvas.height);
        ctx.restore();

        ctx.globalAlpha = 1; // Reset alpha
    },

    /**
     * Dissolves the current image into the next image by revealing random blocks.
     * Note: This implementation reveals blocks dynamically, leading to a 'noisy' dissolve.
     * For a perfectly smooth, non-flickering dissolve, a pre-generated noise map would be needed.
     * @param {CanvasRenderingContext2D} ctx - The 2D rendering context of the canvas.
     * @param {HTMLCanvasElement} canvas - The canvas element.
     * @param {HTMLImageElement} currentImage - The image currently displayed.
     * @param {HTMLImageElement} nextImage - The image to transition to.
     * @param {number} progress - The transition progress (0.0 to 1.0).
     */
    dissolve: (ctx, canvas, currentImage, nextImage, progress) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw currentImage as the base
        ctx.drawImage(currentImage, 0, 0, canvas.width, canvas.height);

        // Reveal parts of nextImage in a grid-like, random fashion
        const DISSOLVE_GRID_SIZE = 24; // Number of cells across width/height
        const DISSOLVE_BLOCK_WIDTH = canvas.width / DISSOLVE_GRID_SIZE;
        const DISSOLVE_BLOCK_HEIGHT = canvas.height / DISSOLVE_GRID_SIZE;

        for (let y = 0; y < DISSOLVE_GRID_SIZE; y++) {
            for (let x = 0; x < DISSOLVE_GRID_SIZE; x++) {
                // Each block has a random chance to reveal the next image
                // Math.random() is called on each frame, so it will appear 'sparkly'.
                if (Math.random() < progress) {
                    ctx.drawImage(nextImage,
                        x * DISSOLVE_BLOCK_WIDTH, y * DISSOLVE_BLOCK_HEIGHT, DISSOLVE_BLOCK_WIDTH, DISSOLVE_BLOCK_HEIGHT, // Source
                        x * DISSOLVE_BLOCK_WIDTH, y * DISSOLVE_BLOCK_HEIGHT, DISSOLVE_BLOCK_WIDTH, DISSOLVE_BLOCK_HEIGHT  // Dest
                    );
                }
            }
        }
    },

    /**
     * Wipes the next image over the current image from left to right.
     * @param {CanvasRenderingContext2D} ctx - The 2D rendering context of the canvas.
     * @param {HTMLCanvasElement} canvas - The canvas element.
     * @param {HTMLImageElement} currentImage - The image currently displayed.
     * @param {HTMLImageElement} nextImage - The image to transition to.
     * @param {number} progress - The transition progress (0.0 to 1.0).
     */
    wipe: (ctx, canvas, currentImage, nextImage, progress) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw currentImage fully as the background
        ctx.drawImage(currentImage, 0, 0, canvas.width, canvas.height);

        // Calculate the width of the nextImage to reveal
        const revealWidth = canvas.width * progress;

        // Draw the visible portion of the nextImage
        if (revealWidth > 0) {
            ctx.drawImage(nextImage,
                0, 0, revealWidth, canvas.height, // Source rectangle from nextImage
                0, 0, revealWidth, canvas.height  // Destination rectangle on canvas
            );
        }
    }
};

// Node.js + Browser uyumlu export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { transitions };
} else if (typeof window !== 'undefined') {
  window.FenixTransitions = transitions;
}