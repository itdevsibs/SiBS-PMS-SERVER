pipeline {
    agent any

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Prepare Docker Project Env') {
            steps {
                sh 'cp /var/jenkins_home/env-files/sibs-pms-server.env "$WORKSPACE/sibs-pms-server.env"'
            }
        }

        stage('Build and Deploy') {
            steps {
                sh 'docker compose -p sibs-pms-server down || true'
                sh 'docker rm -f SiBS-PMS-Server || true'
                sh 'docker compose -p sibs-pms-server up --build -d'
            }
        }
    }

    post {
        always {
            sh 'rm -f "$WORKSPACE/sibs-pms-server.env"'
        }
    }
}