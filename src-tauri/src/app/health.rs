/// Stable health string exposed to the shell until richer status exists.
pub fn core_status_message() -> String {
    "ataraxia-core ready".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_is_stable() {
        assert_eq!(core_status_message(), "ataraxia-core ready");
    }
}
