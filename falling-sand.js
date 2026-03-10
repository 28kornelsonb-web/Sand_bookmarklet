(async()=>{try{if(!navigator.gpu){alert("WebGPU is not supported in this browser. Please use a compatible browser (like Chrome/Edge) and ensure WebGPU is enabled.");return}let e=await navigator.mediaDevices.getDisplayMedia({video:{preferCurrentTab:!0},audio:!1}),i=document.createElement("video");i.srcObject=e,i.play(),await new Promise(e=>{i.onplaying=e}),await new Promise(e=>setTimeout(e,150));let t=window.innerWidth,r=window.innerHeight,u=document.createElement("canvas");u.width=t,u.height=r;let a=u.getContext("2d",{willReadFrequently:!0});a.drawImage(i,0,0,t,r),e.getTracks().forEach(e=>e.stop());let d=a.getImageData(0,0,t,r),o=new Uint32Array(d.data.buffer);for(let n=0;n<o.length;n++)(o[n]>>24&255)<128&&(o[n]=0);let l=await navigator.gpu.requestAdapter(),s=await l.requestDevice(),$=document.createElement("canvas");$.width=t,$.height=r,$.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999998;pointer-events:auto;user-select:none;touch-action:none;",document.body.appendChild($);let c=$.getContext("webgpu"),g=navigator.gpu.getPreferredCanvasFormat();c.configure({device:s,format:g,alphaMode:"premultiplied"}),Array.from(document.body.children).forEach(e=>{e!==$&&"SCRIPT"!==e.tagName&&(e.style.visibility="hidden",e.style.opacity="0")}),document.body.style.background="#111";let f=s.createBuffer({size:o.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});s.queue.writeBuffer(f,0,o);let x=new Float32Array(12),m=new Uint32Array(x.buffer),v=s.createBuffer({size:x.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),h=`
            struct Uniforms {
                width: u32, height: u32, frame: u32, mouse_down: u32,
                mouse_x: f32, mouse_y: f32, mouse_dx: f32, mouse_dy: f32,
                mouse_btn: u32, mouse_radius: f32, pad1: u32, pad2: u32,
            };
        `,p=s.createShaderModule({code:h+`
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
            }`}),y=s.createShaderModule({code:h+`
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
            }`}),w=s.createComputePipeline({layout:"auto",compute:{module:p,entryPoint:"main"}}),b=s.createBindGroup({layout:w.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:f}},{binding:1,resource:{buffer:v}}]}),_=s.createRenderPipeline({layout:"auto",vertex:{module:y,entryPoint:"vs_main"},fragment:{module:y,entryPoint:"fs_main",targets:[{format:g}]},primitive:{topology:"triangle-list"}}),C=s.createBindGroup({layout:_.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:f}},{binding:1,resource:{buffer:v}}]}),E=0,L=0,P=0,S=0,k=0,F=0;$.addEventListener("mousedown",e=>{e.preventDefault(),k=1,F=e.button,E=e.clientX,L=e.clientY,P=0,S=0}),$.addEventListener("mouseup",()=>k=0),$.addEventListener("mousemove",e=>{P=e.clientX-E,S=e.clientY-L,E=e.clientX,L=e.clientY}),$.addEventListener("contextmenu",e=>e.preventDefault());let D=25;$.addEventListener("wheel",e=>{e.preventDefault(),(D-=.05*e.deltaY)<5&&(D=5),D>200&&(D=200)},{passive:!1});let B=0;function G(){B++,m[0]=t,m[1]=r,m[2]=B,m[3]=k,x[4]=E,x[5]=L,x[6]=P,x[7]=S,m[8]=F,x[9]=D,s.queue.writeBuffer(v,0,x);let e=s.createCommandEncoder(),i=e.beginComputePass();i.setPipeline(w),i.setBindGroup(0,b),i.dispatchWorkgroups(Math.ceil(t/16),Math.ceil(r/16)),i.end();let u=e.beginRenderPass({colorAttachments:[{view:c.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:1},loadOp:"clear",storeOp:"store"}]});u.setPipeline(_),u.setBindGroup(0,C),u.draw(3),u.end(),s.queue.submit([e.finish()]),P=0,S=0,requestAnimationFrame(G)}requestAnimationFrame(G)}catch(O){alert("Falling Sand Setup Failed: "+O.message),console.error(O)}})();
