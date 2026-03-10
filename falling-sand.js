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

        // 4. Extract Pixels & Map Colors to Materials
        const imgData = ctx2d.getImageData(0, 0, w, h);
        const pixels = new Uint32Array(imgData.data.buffer);
        
        for (let i = 0; i < pixels.length; i++) {
            let p = pixels[i];
            let a = (p >> 24) & 0xFF;
            
            // Empty space must be exactly 0
            if (a < 128) {
                pixels[i] = 0; 
                continue;
            }
            
            let r = p & 0xFF;
            let g = (p >> 8) & 0xFF;
            let b = (p >> 16) & 0xFF;
            
            let mat = 1; // Default: 1 = Sand
            
            // Material heuristics based on color
            if (b > r * 1.3 && b > g * 1.3) {
                mat = 2; // Blueish = Water (liquid, flows horizontally)
            } else if (r < 50 && g < 50 && b < 50) {
                mat = 3; // Dark = Solid (unmovable structure)
            } else if (r > 220 && g > 220 && b > 220) {
                mat = 4; // White/Light = Smoke (rises upward)
            }
            
            // Pack the material ID into the alpha channel (top 8 bits)
            pixels[i] = ((mat << 24) | (b << 16) | (g << 8) | r) >>> 0;
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
                mouse_btn: u32, mouse_radius: f32, brush_value: u32, pad2: u32,
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
                            // Left click: Paint / Dig (based on current material)
                            atomicStore(&grid[idx], u.brush_value);
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

                // --- Material Physics ---
                let val = atomicLoad(&grid[idx]);
                if (val == 0u) { return; }
                
                // Extract material ID from the alpha channel
                let mat = (val >> 24u) & 0xFFu;
                if (mat == 3u) { return; } // Solid material doesn't move

                var dir_y: i32 = 1; // Default fall down
                if (mat == 4u) { dir_y = -1; } // Smoke moves up
                
                let next_y = i32(y) + dir_y;
                var moved = false;

                if (next_y >= 0 && next_y < i32(u.height)) {
                    let down_idx = u32(next_y) * u.width + x;
                    
                    // Try straight down (or up)
                    if (atomicLoad(&grid[down_idx]) == 0u) {
                        if (atomicCompareExchangeWeak(&grid[down_idx], 0u, val).exchanged) {
                            atomicStore(&grid[idx], 0u);
                            return;
                        }
                    }

                    // Try diagonal sliding (alternate left/right based on frame parity to prevent bias)
                    let dir = (x + y + u.frame) % 2u;

                    if (dir == 0u && x > 0u) {
                        let dl_idx = u32(next_y) * u.width + (x - 1u);
                        if (atomicLoad(&grid[dl_idx]) == 0u) {
                            if (atomicCompareExchangeWeak(&grid[dl_idx], 0u, val).exchanged) {
                                atomicStore(&grid[idx], 0u);
                                moved = true;
                            }
                        }
                    } else if (dir == 1u && x < u.width - 1u) {
                        let dr_idx = u32(next_y) * u.width + (x + 1u);
                        if (atomicLoad(&grid[dr_idx]) == 0u) {
                            if (atomicCompareExchangeWeak(&grid[dr_idx], 0u, val).exchanged) {
                                atomicStore(&grid[idx], 0u);
                                moved = true;
                            }
                        }
                    }

                    if (!moved) {
                        if (dir == 1u && x > 0u) {
                            let dl_idx = u32(next_y) * u.width + (x - 1u);
                            if (atomicLoad(&grid[dl_idx]) == 0u) {
                                if (atomicCompareExchangeWeak(&grid[dl_idx], 0u, val).exchanged) {
                                    atomicStore(&grid[idx], 0u);
                                    moved = true;
                                }
                            }
                        } else if (dir == 0u && x < u.width - 1u) {
                            let dr_idx = u32(next_y) * u.width + (x + 1u);
                            if (atomicLoad(&grid[dr_idx]) == 0u) {
                                if (atomicCompareExchangeWeak(&grid[dr_idx], 0u, val).exchanged) {
                                    atomicStore(&grid[idx], 0u);
                                    moved = true;
                                }
                            }
                        }
                    }
                }

                // Horizontal flowing for Water (2) and Smoke (4)
                if (!moved && (mat == 2u || mat == 4u)) {
                    let dir = (x + y + u.frame) % 2u;
                    if (dir == 0u && x > 0u) {
                        let l_idx = y * u.width + (x - 1u);
                        if (atomicLoad(&grid[l_idx]) == 0u) {
                            if (atomicCompareExchangeWeak(&grid[l_idx], 0u, val).exchanged) {
                                atomicStore(&grid[idx], 0u);
                            }
                        }
                    } else if (dir == 1u && x < u.width - 1u) {
                        let r_idx = y * u.width + (x + 1u);
                        if (atomicLoad(&grid[r_idx]) == 0u) {
                            if (atomicCompareExchangeWeak(&grid[r_idx], 0u, val).exchanged) {
                                atomicStore(&grid[idx], 0u);
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
                
                // Alpha channel now holds material ID, so we ignore it for transparency
                // and just render the pixel as fully opaque.
                return vec4<f32>(r, g, b, 1.0);
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

        // 9. Input & API Architecture
        let mouseX = 0, mouseY = 0, mouseDx = 0, mouseDy = 0;
        let mouseDown = 0, mouseBtn = 0;
        let brushRadius = 25.0;
        let currentBrushValue = 0; // Starts with Eraser/0

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
        canvas.addEventListener('wheel', e => {
            e.preventDefault();
            brushRadius -= e.deltaY * 0.05;
            if (brushRadius < 5.0) brushRadius = 5.0;
            if (brushRadius > 200.0) brushRadius = 200.0;
            if (window.updateBrushSliderUI) window.updateBrushSliderUI(brushRadius);
        }, { passive: false });

        // Global Particle API for External Extensions
        window.ParticleAPI = {
            setBrushMaterial: (matId, hexColor) => {
                if (matId === 0) {
                    currentBrushValue = 0;
                    return;
                }
                let r = parseInt(hexColor.substr(1, 2), 16);
                let g = parseInt(hexColor.substr(3, 2), 16);
                let b = parseInt(hexColor.substr(5, 2), 16);
                currentBrushValue = ((matId << 24) | (b << 16) | (g << 8) | r) >>> 0;
            },
            setBrushSize: (size) => { brushRadius = size; },
            clearScreen: () => {
                const emptyPixels = new Uint32Array(pixels.length);
                device.queue.writeBuffer(gridBuffer, 0, emptyPixels);
            }
        };

        // 10. Graphical User Interface (GUI) Construction
        const gui = document.createElement('div');
        gui.style.cssText = "position:fixed;top:20px;right:20px;background:rgba(20,20,20,0.9);color:#eee;padding:15px;border-radius:10px;z-index:999999;font-family:sans-serif;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 16px rgba(0,0,0,0.5);width:220px;border:1px solid #444;user-select:none;";
        
        // Stop all events so painting doesn't happen under the GUI
        ['mousedown','mouseup','mousemove','wheel','contextmenu','click'].forEach(evt => {
            gui.addEventListener(evt, e => e.stopPropagation());
        });

        const title = document.createElement('h3');
        title.style.cssText = "margin:0;padding-bottom:10px;border-bottom:1px solid #555;font-size:16px;text-align:center;";
        title.textContent = "Particle Sandbox";
        gui.appendChild(title);

        // Brush Settings
        const sizeContainer = document.createElement('div');
        sizeContainer.innerHTML = `<label style="font-size:12px;display:block;margin-bottom:5px;">Brush Size: <span id="p-brush-size">25</span>px</label>
                                   <input type="range" min="5" max="200" value="25" id="p-slider" style="width:100%;">`;
        gui.appendChild(sizeContainer);
        
        const slider = sizeContainer.querySelector('#p-slider');
        const sizeLabel = sizeContainer.querySelector('#p-brush-size');
        slider.addEventListener('input', (e) => {
            window.ParticleAPI.setBrushSize(parseFloat(e.target.value));
            sizeLabel.textContent = e.target.value;
        });
        window.updateBrushSliderUI = (val) => {
            slider.value = Math.round(val);
            sizeLabel.textContent = Math.round(val);
        };

        // Material Palette Array (Extendable)
        const materials = [
            { name: 'Sand', id: 1, hex: '#dcc864' },
            { name: 'Water', id: 2, hex: '#3264ff' },
            { name: 'Wall', id: 3, hex: '#888888' }, // Changed to lighter grey so it's visible against the void
            { name: 'Smoke', id: 4, hex: '#dcdcdc' },
            { name: 'Eraser', id: 0, hex: '#000000' }
        ];

        window.ParticleAPI.setBrushMaterial(1, '#dcc864'); // Default material is Sand

        const paletteTitle = document.createElement('div');
        paletteTitle.style.cssText = "font-size:12px;margin-top:5px;";
        paletteTitle.textContent = "Materials (LMB to Draw, RMB to Drag):";
        gui.appendChild(paletteTitle);

        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;";
        
        materials.forEach(mat => {
            const btn = document.createElement('button');
            btn.textContent = mat.name;
            btn.style.cssText = `padding:8px;border:2px solid transparent;border-radius:6px;background:#333;color:white;cursor:pointer;font-weight:bold;font-size:12px;display:flex;align-items:center;gap:6px;`;
            
            // Color indicator dot
            const dot = document.createElement('span');
            dot.style.cssText = `display:inline-block;width:12px;height:12px;border-radius:50%;background:${mat.hex};border:1px solid #111;`;
            if (mat.id === 0) dot.style.border = '1px solid #fff'; // Highlight eraser dot
            
            btn.prepend(dot);
            
            btn.onclick = () => {
                window.ParticleAPI.setBrushMaterial(mat.id, mat.hex);
                Array.from(btnContainer.children).forEach(b => b.style.borderColor = 'transparent');
                btn.style.borderColor = '#fff'; // Active state
            };
            btnContainer.appendChild(btn);
            
            if (mat.id === 1) btn.style.borderColor = '#fff'; // Initial Active state
        });
        gui.appendChild(btnContainer);

        const clearBtn = document.createElement('button');
        clearBtn.textContent = "Clear Screen";
        clearBtn.style.cssText = "margin-top:10px;padding:8px;background:#a33;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:bold;";
        clearBtn.onclick = () => window.ParticleAPI.clearScreen();
        gui.appendChild(clearBtn);

        document.body.appendChild(gui);

        // 11. Render Loop
        let frame = 0;
        function render() {
            frame++;

            // Sync uniforms to GPU
            uniformDataU32[0] = w; uniformDataU32[1] = h; uniformDataU32[2] = frame; uniformDataU32[3] = mouseDown;
            uniformData[4] = mouseX; uniformData[5] = mouseY; uniformData[6] = mouseDx; uniformData[7] = mouseDy;
            uniformDataU32[8] = mouseBtn; uniformData[9] = brushRadius; 
            uniformDataU32[10] = currentBrushValue; // Current brush passed to compute shader
            
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
