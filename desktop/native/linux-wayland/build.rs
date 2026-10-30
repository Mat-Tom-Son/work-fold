fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let ei = pkg_config::Config::new()
        .atleast_version("1.2")
        .probe("libei-1.0")
        .unwrap();
    let eis = pkg_config::Config::new()
        .atleast_version("1.2")
        .probe("libeis-1.0")
        .unwrap();
    let mut builder = bindgen::Builder::default()
        .header_contents(
            "work_fold_ei.h",
            "#include <libei.h>\n#include <libeis.h>\n",
        )
        .allowlist_function("ei_.*|eis_.*")
        .allowlist_type("ei.*")
        .allowlist_var("EI.*")
        .derive_debug(false)
        .prepend_enum_name(false)
        .layout_tests(false)
        .generate_comments(false);
    for path in ei.include_paths.iter().chain(eis.include_paths.iter()) {
        builder = builder.clang_arg(format!("-I{}", path.display()));
    }
    builder
        .generate()
        .unwrap()
        .write_to_file(
            std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("ei_bindings.rs"),
        )
        .unwrap();
}
