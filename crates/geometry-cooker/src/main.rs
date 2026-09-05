use std::path::PathBuf;
use strata_geometry_cooker::{
    Config, LodProfile, PAGE_BYTES, cook_trace_proxy, cook_with_profile, write_cooked,
    write_trace_proxy,
};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = Config::default();
    let mut output: Option<PathBuf> = None;
    let mut trace_proxy = false;
    let mut profile = LodProfile::Legacy;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--help" {
            println!(
                "strata-geometry-cooker [--output EXTERNAL_DIRECTORY] [--seed U32] [--tiles 1..16] [--cells 8|16|32|64|128] [--lod-profile legacy|certified] [--trace-proxy (seed1337/tiles4/cells64 only)]"
            );
            return Ok(());
        }
        if argument == "--trace-proxy" {
            trace_proxy = true;
            continue;
        }
        let value = args.next().ok_or("Missing flag value")?;
        match argument.as_str() {
            "--output" => output = Some(value.into()),
            "--seed" => config.seed = value.parse()?,
            "--tiles" => config.tiles = value.parse()?,
            "--cells" => config.cells = value.parse()?,
            "--lod-profile" => {
                profile = match value.as_str() {
                    "legacy" => LodProfile::Legacy,
                    "certified" => LodProfile::Certified,
                    _ => return Err("LOD profile must be legacy or certified.".into()),
                }
            }
            _ => return Err(format!("Unknown argument: {argument}").into()),
        }
    }
    config.validate()?;
    if trace_proxy && (config.seed != 1337 || config.tiles != 4 || config.cells != 64) {
        return Err("Trace proxy v1 requires seed1337, tiles4, cells64.".into());
    }
    let output = output.unwrap_or_else(|| {
        PathBuf::from(
            std::env::var_os("HOME").unwrap_or_else(|| std::env::temp_dir().into_os_string()),
        )
        .join("Downloads/Strata-Cooked-Geometry")
        .join(format!(
            "terrain-v1-s{}-t{}-c{}{}",
            config.seed,
            config.tiles,
            config.cells,
            if profile == LodProfile::Certified {
                "-certified-v1"
            } else {
                ""
            }
        ))
    });
    let cooked = cook_with_profile(config, profile)?;
    let proxy = if trace_proxy {
        Some(cook_trace_proxy(config, &cooked.manifest)?)
    } else {
        None
    };
    write_cooked(&output, &cooked)?;
    if let Some(proxy) = proxy {
        write_trace_proxy(&output, &proxy)?;
        println!(
            "Trace proxy:2048 triangles, {} bytes, measured vertical error{}m, conservative bound{}m.",
            proxy.payload.len(),
            proxy.measured_max_vertical_error,
            proxy.max_vertical_error
        );
    }
    println!(
        "Cooked {} unique source triangles into {} clusters, {} pages ({} bytes), {} pinned root pages.\nManifest: {}",
        cooked.source_triangles,
        cooked.cluster_count,
        cooked.pages.len(),
        cooked.pages.len() * PAGE_BYTES,
        cooked.root_pages,
        output.join("manifest.json").display()
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
