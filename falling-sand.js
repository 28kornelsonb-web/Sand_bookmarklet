/**
 * Interactive Falling Sand Page Bookmarklet
 * -----------------------------------------
 * Captures the DOM visually, converts it to a GPU-simulated sand grid,
 * and lets you drag and dig through the webpage.
 * * Tech: html2canvas + WebGPU Compute Shaders
 */
(async () => {
    try {
        // 1. Check for WebGPU Support
        if (!navigator.gpu) {
            alert("WebGPU is not supported in this browser. Please use a compatible browser (like Chrome/Edge) and ensure WebGPU is enabled.");
            return;
        }

        // 2. Capture the screen via DisplayMedia API
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { preferCurrentTab: true },
            audio: false
        });

        const video = document.createElement('video');
        video.srcObject = stream;
        video.play();
        
        // Wait for video stream to start flowing
        await new Promise(resolve => {
            video.onplaying = resolve;
        });
        // A tiny delay to guarantee the first frame is painted
        await new Promise(resolve => setTimeout(resolve, 150));

        // 3. Extract pixels from the video stream
        const w = window.innerWidth;
        const h = window.innerHeight;
        
        const captureCanvas = document.createElement('canvas');
        captureCanvas.width = w;
        captureCanvas.height = h;
        
        const ctx2d = captureCanvas.getContext('2d', { willReadFrequently: true });
        ctx2d.drawImage(video, 0, 0, w, h);
        
        // We have our screenshot! Stop the screen sharing stream
        stream.getTracks().forEach(track => track.stop());

        // 4. Extract Pixels & map Alpha to solid (avoiding empty trailing invisible sands)
        const imgData = ctx2d.getImageData(0, 0, w, h);
        const pixels = new Uint32Array(imgData.data.buffer);
        
        for (let i = 0; i < pixels.length; i++) {
            // Check alpha channel (little endian: A is top 8 bits). Empty space must be exactly 0.
            if (((pixels[i] >> 24) & 0xFF) < 128) pixels[i] = 0; 
        }

        // 5. Initialize WebGPU
        const adapter = await navigator.gpu.requestAdapter();
        const device = await adapter.requestDevice();

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999998;pointer-events:auto;user-select:none;touch-action:none;";
        document.body.appendChild(canvas);

        const context = canvas.getContext('webgpu');
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: 'premultiplied' });

        // Hide original page content to sell the illusion
        Array.from(document.body.children).forEach(child => {
            if (child !== canvas && child.tagName !== 'SCRIPT') {
                child.style.visibility = 'hidden';
                child.style.opacity = '0';
            }
        });
        document.body.style.background = '#111';

        // 6. Data Buffers
        const gridBuffer = device.createBuffer({
            size: pixels.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(gridBuffer, 0, pixels);

        const uniformData = new Float32Array(12); // 48 bytes (aligned)
        const uniformDataU32 = new Uint32Array(uniformData.buffer);
        const uniformBuffer = device.createBuffer({
            size: uniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // 7. Shaders
        const wgslUniforms = `
            struct Uniforms {
                width: u32, height: u32, frame: u32, mouse_down: u32,
                mouse_x: f32, mouse_y: f32, mouse_dx: f32, mouse_dy: f32,
                mouse_btn: u32, mouse_radius: f32, pad1: u32, pad2: u32,
            };
        `;

        const computeModule = device.createShaderModule({
            code: wgslUniforms + `
            @group(0) @binding(0) var<storage, read_write> grid: array<atomic<u32>>;
            @group(0) @binding(1) var<uniform> u: Uniforms;

            @compute @workgroup_size(16, 16)
            fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                let x = id.x;
                let y = id.y;
                if (x >= u.width || y >= u.height) { return; }

                let idx = y * u.width + x;

                // --- Interactions ---
                if (u.mouse_down > 0u) {
                    let dx = f32(x) - u.mouse_x;
                    let dy = f32(y) - u.mouse_y;
                    if (dx*dx + dy*dy < u.mouse_radius * u.mouse_radius) {
                        if (u.mouse_btn == 0u) {
                            // Left click: Dig / Delete
                            atomicStore(&grid[idx], 0u);
                            return;
                        } else if (u.mouse_btn == 2u) {
                            // Right click: Grab & Move
                            let val = atomicLoad(&grid[idx]);
                            if (val != 0u) {
                                var tx_i = i32(x) + i32(u.mouse_dx);
                                if (tx_i < 0) { tx_i = 0; } else if (tx_i >= i32(u.width)) { tx_i = i32(u.width) - 1; }
                                var ty_i = i32(y) + i32(u.mouse_dy);
                                if (ty_i < 0) { ty_i = 0; } else if (ty_i >= i32(u.height)) { ty_i = i32(u.height) - 1; }
                                
                                let tidx = u32(ty_i) * u.width + u32(tx_i);
                                if (tidx != idx) {
                                    let target_val = atomicLoad(&grid[tidx]);
                                    if (target_val == 0u) {
                                        if (atomicCompareExchangeWeak(&grid[tidx], 0u, val).exchanged) {
                                            atomicStore(&grid[idx], 0u);
                                        }
                                    }
                                }
                            }
                            return; // Suspend gravity while held
                        }
                    }
                }

                // --- Sand Physics ---
                let val = atomicLoad(&grid[idx]);
                if (val == 0u) { return; }

                if (y < u.height - 1u) {
                    let down_idx = (y + 1u) * u.width + x;
                    
                    // Try straight down
                    if (atomicLoad(&grid[down_idx]) == 0u) {
                        if (atomicCompareExchangeWeak(&grid[down_idx], 0u, val).exchanged) {
                            atomicStore(&grid[idx], 0u);
                            return;
                        }
                    }

                    // Try diagonal sliding (alternate left/right based on frame parity to prevent bias)
                    let dir = (x + y + u.frame) % 2u;
                    var moved = false;

                    if (dir == 0u && x > 0u) {
                        let dl_idx = (y + 1u) * u.width + (x - 1u);
                        if (atomicLoad(&grid[dl_idx]) == 0u) {
                            if (atomicCompareExchangeWeak(&grid[dl_idx], 0u, val).exchanged) {
                                atomicStore(&grid[idx], 0u);
                                moved = true;
                            }
                        }
                    } else if (dir == 1u && x < u.width - 1u) {
                        let dr_idx = (y + 1u) * u.width + (x + 1u);
                        if (atomicLoad(&grid[dr_idx]) == 0u) {
                            if (atomicCompareExchangeWeak(&grid[dr_idx], 0u, val).exchanged) {
                                atomicStore(&grid[idx], 0u);
                                moved = true;
                            }
                        }
                    }

                    if (!moved) {
                        if (dir == 1u && x > 0u) {
                            let dl_idx = (y + 1u) * u.width + (x - 1u);
                            if (atomicLoad(&grid[dl_idx]) == 0u) {
                                if (atomicCompareExchangeWeak(&grid[dl_idx], 0u, val).exchanged) {
                                    atomicStore(&grid[idx], 0u);
                                }
                            }
                        } else if (dir == 0u && x < u.width - 1u) {
                            let dr_idx = (y + 1u) * u.width + (x + 1u);
                            if (atomicLoad(&grid[dr_idx]) == 0u) {
                                if (atomicCompareExchangeWeak(&grid[dr_idx], 0u, val).exchanged) {
                                    atomicStore(&grid[idx], 0u);
                                }
                            }
                        }
                    }
                }
            }`
        });

        const renderModule = device.createShaderModule({
            code: wgslUniforms + `
            @group(0) @binding(0) var<storage, read> grid: array<u32>;
            @group(0) @binding(1) var<uniform> u: Uniforms;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>,
            };

            @vertex
            fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
                var pos = array<vec2<f32>, 3>(
                    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
                );
                var out: VertexOutput;
                out.position = vec4<f32>(pos[vi], 0.0, 1.0);
                out.uv = pos[vi] * 0.5 + 0.5;
                out.uv.y = 1.0 - out.uv.y;
                return out;
            }

            @fragment
            fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
                let x = u32(in.uv.x * f32(u.width));
                let y = u32(in.uv.y * f32(u.height));
                if (x >= u.width || y >= u.height) { discard; }

                let val = grid[y * u.width + x];
                if (val == 0u) {
                    return vec4<f32>(0.07, 0.07, 0.07, 1.0); // Dark grey void background
                }

                // Decode little-endian RGBA
                let r = f32(val & 0xFFu) / 255.0;
                let g = f32((val >> 8u) & 0xFFu) / 255.0;
                let b = f32((val >> 16u) & 0xFFu) / 255.0;
                let a = f32((val >> 24u) & 0xFFu) / 255.0;

                return vec4<f32>(r, g, b, a);
            }`
        });

        // 8. Pipelines & BindGroups
        const computePipeline = device.createComputePipeline({
            layout: 'auto', compute: { module: computeModule, entryPoint: 'main' }
        });
        const computeBindGroup = device.createBindGroup({
            layout: computePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: gridBuffer } },
                { binding: 1, resource: { buffer: uniformBuffer } }
            ]
        });

        const renderPipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module: renderModule, entryPoint: 'vs_main' },
            fragment: { module: renderModule, entryPoint: 'fs_main', targets: [{ format }] },
            primitive: { topology: 'triangle-list' }
        });
        const renderBindGroup = device.createBindGroup({
            layout: renderPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: gridBuffer } },
                { binding: 1, resource: { buffer: uniformBuffer } }
            ]
        });

        // 9. Mouse Listeners
        let mouseX = 0, mouseY = 0, mouseDx = 0, mouseDy = 0;
        let mouseDown = 0, mouseBtn = 0;

        canvas.addEventListener('mousedown', e => {
            e.preventDefault();
            mouseDown = 1; mouseBtn = e.button;
            mouseX = e.clientX; mouseY = e.clientY;
            mouseDx = 0; mouseDy = 0;
        });
        canvas.addEventListener('mouseup', () => mouseDown = 0);
        canvas.addEventListener('mousemove', e => {
            mouseDx = e.clientX - mouseX; mouseDy = e.clientY - mouseY;
            mouseX = e.clientX; mouseY = e.clientY;
        });
        canvas.addEventListener('contextmenu', e => e.preventDefault());

        // 9b. Scroll Wheel for Brush Size
        let brushRadius = 25.0;
        canvas.addEventListener('wheel', e => {
            e.preventDefault();
            brushRadius -= e.deltaY * 0.05;
            if (brushRadius < 5.0) brushRadius = 5.0;
            if (brushRadius > 200.0) brushRadius = 200.0;
        }, { passive: false });

        // 10. Render Loop
        let frame = 0;
        function render() {
            frame++;

            // Sync uniforms to GPU
            uniformDataU32[0] = w; uniformDataU32[1] = h; uniformDataU32[2] = frame; uniformDataU32[3] = mouseDown;
            uniformData[4] = mouseX; uniformData[5] = mouseY; uniformData[6] = mouseDx; uniformData[7] = mouseDy;
            uniformDataU32[8] = mouseBtn; uniformData[9] = brushRadius; // Brush Radius dynamically updated
            device.queue.writeBuffer(uniformBuffer, 0, uniformData);

            const commandEncoder = device.createCommandEncoder();

            // Run Physics Pass
            const computePass = commandEncoder.beginComputePass();
            computePass.setPipeline(computePipeline);
            computePass.setBindGroup(0, computeBindGroup);
            computePass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
            computePass.end();

            // Run Render Pass
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: context.getCurrentTexture().createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: 'clear', storeOp: 'store'
                }]
            });
            renderPass.setPipeline(renderPipeline);
            renderPass.setBindGroup(0, renderBindGroup);
            renderPass.draw(3); // Draw full-screen triangle
            renderPass.end();

            device.queue.submit([commandEncoder.finish()]);

            mouseDx = 0; mouseDy = 0; // Clear mouse delta
            requestAnimationFrame(render);
        }
        
        requestAnimationFrame(render);

    } catch (err) {
        alert("Falling Sand Setup Failed: " + err.message);
        console.error(err);
    }
})();
