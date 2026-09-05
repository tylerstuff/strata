use std::path::PathBuf;
use strata_geometry_cooker::{Config, PAGE_BYTES, cook, write_cooked};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = Config::default();
    let mut output: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--help" {
            println!(
                "strata-geometry-cooker [--output EXTERNAL_DIRECTORY] [--seed U32] [--tiles 1..16] [--cells 8|16|32|64|128]"
            );
            return Ok(());
        }
        let value = args.next().ok_or("Missing flag value")?;
        match argument.as_str() {
            "--output" => output = Some(value.into()),
            "--seed" => config.seed = value.parse()?,
            "--tiles" => config.tiles = value.parse()?,
            "--cells" => config.cells = value.parse()?,
            _ => return Err(format!("Unknown argument: {argument}").into()),
        }
    }
    config.validate()?;
    let output = output.unwrap_or_else(|| {
        PathBuf::from(
            std::env::var_os("HOME").unwrap_or_else(|| std::env::temp_dir().into_os_string()),
        )
        .join("Downloads/Strata-Cooked-Geometry")
        .join(format!(
            "terrain-v1-s{}-t{}-c{}",
            config.seed, config.tiles, config.cells
        ))
    });
    let cooked = cook(config)?;
    write_cooked(&output, &cooked)?;
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
