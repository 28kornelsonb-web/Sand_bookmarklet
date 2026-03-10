(async()=>{try{if(!navigator.gpu){alert("WebGPU is not supported in this browser. Please use a compatible browser (like Chrome/Edge) and ensure WebGPU is enabled.");return}let e=document.createElement("div");e.innerText="Rasterizing DOM & Initializing Physics...",e.style.cssText="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.8);color:#fff;padding:20px 30px;border-radius:8px;z-index:9999999;font-family:sans-serif;font-weight:bold;",document.body.appendChild(e),await new Promise((e,i)=>{if(window.html2canvas)return e();let t=document.createElement("script");t.src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",t.onload=e,t.onerror=()=>i(Error("Failed to load html2canvas")),document.head.appendChild(t)});let i=window.innerWidth,t=window.innerHeight,r=await html2canvas(document.body,{windowWidth:i,windowHeight:t,x:window.scrollX,y:window.scrollY,width:i,height:t,useCORS:!0,backgroundColor:null,scale:1}),a=r.getContext("2d",{willReadFrequently:!0}),u=a.getImageData(0,0,i,t),d=new Uint32Array(u.data.buffer);for(let o=0;o<d.length;o++)(d[o]>>24&255)<128&&(d[o]=0);let n=await navigator.gpu.requestAdapter(),l=await n.requestDevice(),s=document.createElement("canvas");s.width=i,s.height=t,s.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999998;pointer-events:auto;user-select:none;touch-action:none;",document.body.appendChild(s);let c=s.getContext("webgpu"),f=navigator.gpu.getPreferredCanvasFormat();c.configure({device:l,format:f,alphaMode:"premultiplied"}),Array.from(document.body.children).forEach(i=>{i!==s&&i!==e&&"SCRIPT"!==i.tagName&&(i.style.visibility="hidden",i.style.opacity="0")}),document.body.style.background="#111",e.remove();let g=l.createBuffer({size:d.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});l.queue.writeBuffer(g,0,d);let $=new Float32Array(12),x=new Uint32Array($.buffer),m=l.createBuffer({size:$.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),h=`
            struct Uniforms {
                width: u32, height: u32, frame: u32, mouse_down: u32,
                mouse_x: f32, mouse_y: f32, mouse_dx: f32, mouse_dy: f32,
                mouse_btn: u32, mouse_radius: f32, pad1: u32, pad2: u32,
            };
        `,v=l.createShaderModule({code:h+`
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
                        if (u.mouse_btn == 2u) {
                            // Right click: Dig / Delete
                            atomicStore(&grid[idx], 0u);
                            return;
                        } else if (u.mouse_btn == 0u) {
                            // Left click: Grab & Move
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
            }`}),p=l.createShaderModule({code:h+`
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
            }`}),y=l.createComputePipeline({layout:"auto",compute:{module:v,entryPoint:"main"}}),b=l.createBindGroup({layout:y.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:g}},{binding:1,resource:{buffer:m}}]}),w=l.createRenderPipeline({layout:"auto",vertex:{module:p,entryPoint:"vs_main"},fragment:{module:p,entryPoint:"fs_main",targets:[{format:f}]},primitive:{topology:"triangle-list"}}),_=l.createBindGroup({layout:w.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:g}},{binding:1,resource:{buffer:m}}]}),C=0,P=0,S=0,E=0,L=0,k=0;s.addEventListener("mousedown",e=>{e.preventDefault(),L=1,k=e.button,C=e.clientX,P=e.clientY,S=0,E=0}),s.addEventListener("mouseup",()=>L=0),s.addEventListener("mousemove",e=>{S=e.clientX-C,E=e.clientY-P,C=e.clientX,P=e.clientY}),s.addEventListener("contextmenu",e=>e.preventDefault());let F=0;function O(){F++,x[0]=i,x[1]=t,x[2]=F,x[3]=L,$[4]=C,$[5]=P,$[6]=S,$[7]=E,x[8]=k,$[9]=25,l.queue.writeBuffer(m,0,$);let e=l.createCommandEncoder(),r=e.beginComputePass();r.setPipeline(y),r.setBindGroup(0,b),r.dispatchWorkgroups(Math.ceil(i/16),Math.ceil(t/16)),r.end();let a=e.beginRenderPass({colorAttachments:[{view:c.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:1},loadOp:"clear",storeOp:"store"}]});a.setPipeline(w),a.setBindGroup(0,_),a.draw(3),a.end(),l.queue.submit([e.finish()]),S=0,E=0,requestAnimationFrame(O)}requestAnimationFrame(O)}catch(B){alert("Falling Sand Setup Failed: "+B.message),console.error(B)}})();
